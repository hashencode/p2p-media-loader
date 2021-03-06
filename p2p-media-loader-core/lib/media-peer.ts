import * as Debug from "debug";
import { STEEmitter } from "./stringly-typed-event-emitter";
import { Buffer } from "buffer";

enum MediaPeerCommands {
    SegmentData,
    SegmentAbsent,
    SegmentsMap,
    SegmentRequest,
    CancelSegmentRequest,
}

export enum MediaPeerSegmentStatus {
    Loaded,
    LoadingByHttp,
}

class DownloadingSegment {
    public bytesDownloaded = 0;
    public pieces: ArrayBuffer[] = [];
    constructor(readonly id: string, readonly size: number) {}
}

export class MediaPeer extends STEEmitter<
    | "connect"
    | "close"
    | "data-updated"
    | "segment-request"
    | "segment-absent"
    | "segment-loaded"
    | "segment-error"
    | "segment-timeout"
    | "bytes-downloaded"
    | "bytes-uploaded"
> {
    public id: string;
    public remoteAddress: string = "";
    private downloadingSegmentId: string | null = null;
    private downloadingSegment: DownloadingSegment | null = null;
    private segmentsMap = new Map<string, MediaPeerSegmentStatus>();
    private debug = Debug("p2pml:media-peer");
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        readonly peer: any,
        readonly settings: {
            p2pSegmentDownloadTimeout: number;
            webRtcMaxMessageSize: number;
        }
    ) {
        super();

        this.peer.on("connect", this.onPeerConnect);
        this.peer.on("close", this.onPeerClose);
        this.peer.on("error", this.onPeerError);
        this.peer.on("data", this.onPeerData);

        this.id = peer.id;
    }

    private onPeerConnect = () => {
        this.debug("peer connect", this.id, this);
        this.remoteAddress = this.peer.remoteAddress;
        this.emit("connect", this);
    };

    private onPeerClose = () => {
        this.debug("peer close", this.id, this);
        this.terminateSegmentRequest();
        this.emit("close", this);
    };

    private onPeerError = (error: any) => {
        this.debug("peer error", this.id, error, this);
    };

    private receiveSegmentPiece(data: ArrayBuffer): void {
        if (!this.downloadingSegment) {
            // The segment was not requested or canceled
            this.debug("peer segment not requested", this.id, this);
            return;
        }

        this.downloadingSegment.bytesDownloaded += data.byteLength;
        this.downloadingSegment.pieces.push(data);
        this.emit("bytes-downloaded", this, data.byteLength);

        const segmentId = this.downloadingSegment.id;

        if (
            this.downloadingSegment.bytesDownloaded ==
            this.downloadingSegment.size
        ) {
            const segmentData = new Uint8Array(this.downloadingSegment.size);
            let offset = 0;
            for (const piece of this.downloadingSegment.pieces) {
                segmentData.set(new Uint8Array(piece), offset);
                offset += piece.byteLength;
            }

            this.debug("peer segment download done", this.id, segmentId, this);
            this.terminateSegmentRequest();
            this.emit("segment-loaded", this, segmentId, segmentData.buffer);
        } else if (
            this.downloadingSegment.bytesDownloaded >
            this.downloadingSegment.size
        ) {
            this.debug(
                "peer segment download bytes mismatch",
                this.id,
                segmentId,
                this
            );
            this.terminateSegmentRequest();
            this.emit(
                "segment-error",
                this,
                segmentId,
                "Too many bytes received for segment"
            );
        }
    }

    private getJsonCommand(data: ArrayBuffer): any {
        const bytes = new Uint8Array(data);

        // Serialized JSON string check by first, second and last characters: '{" .... }'
        if (
            bytes[0] == 123 &&
            bytes[1] == 34 &&
            bytes[data.byteLength - 1] == 125
        ) {
            try {
                return JSON.parse(new TextDecoder().decode(data));
            } catch {}
        }

        return null;
    }

    private onPeerData = (data: ArrayBuffer) => {
        const command = this.getJsonCommand(data);

        if (command == null) {
            this.receiveSegmentPiece(data);
            return;
        }

        if (this.downloadingSegment) {
            this.debug(
                "peer segment download is interrupted by a command",
                this.id,
                this
            );

            const segmentId = this.downloadingSegment.id;
            this.terminateSegmentRequest();
            this.emit(
                "segment-error",
                this,
                segmentId,
                "Segment download is interrupted by a command"
            );
            return;
        }

        this.debug("peer receive command", this.id, command, this);

        switch (command.c) {
            case MediaPeerCommands.SegmentsMap:
                this.segmentsMap = this.createSegmentsMap(command.m);
                this.emit("data-updated");
                break;

            case MediaPeerCommands.SegmentRequest:
                this.emit("segment-request", this, command.i);
                break;

            case MediaPeerCommands.SegmentData:
                if (this.downloadingSegmentId === command.i) {
                    this.downloadingSegment = new DownloadingSegment(
                        command.i,
                        command.s
                    );
                    this.cancelResponseTimeoutTimer();
                }
                break;

            case MediaPeerCommands.SegmentAbsent:
                if (this.downloadingSegmentId === command.i) {
                    this.terminateSegmentRequest();
                    this.segmentsMap.delete(command.i);
                    this.emit("segment-absent", this, command.i);
                }
                break;

            case MediaPeerCommands.CancelSegmentRequest:
                // TODO: peer stop sending buffer
                break;

            default:
                break;
        }
    };

    private createSegmentsMap(
        segments: any
    ): Map<string, MediaPeerSegmentStatus> {
        if (segments == undefined || !(segments instanceof Object)) {
            return new Map();
        }

        const segmentsMap = new Map<string, MediaPeerSegmentStatus>();

        for (const streamSwarmId of Object.keys(segments)) {
            const swarmData = segments[streamSwarmId];
            if (
                !(swarmData instanceof Array) ||
                swarmData.length !== 2 ||
                typeof swarmData[0] !== "string" ||
                !(swarmData[1] instanceof Array)
            ) {
                return new Map();
            }

            const segmentsIds = (swarmData[0] as string).split("|");
            const segmentsStatuses = swarmData[1] as MediaPeerSegmentStatus[];

            if (segmentsIds.length !== segmentsStatuses.length) {
                return new Map();
            }

            for (let i = 0; i < segmentsIds.length; i++) {
                const segmentStatus = segmentsStatuses[i];
                if (
                    typeof segmentStatus !== "number" ||
                    MediaPeerSegmentStatus[segmentStatus] === undefined
                ) {
                    return new Map();
                }

                segmentsMap.set(
                    `${streamSwarmId}+${segmentsIds[i]}`,
                    segmentStatus
                );
            }
        }

        return segmentsMap;
    }

    private sendCommand(command: any): void {
        this.debug("peer send command", this.id, command, this);
        this.peer.write(JSON.stringify(command));
    }

    public destroy(): void {
        this.debug("peer destroy", this.id, this);
        this.terminateSegmentRequest();
        this.peer.destroy();
    }

    public getDownloadingSegmentId(): string | null {
        return this.downloadingSegmentId;
    }

    public getSegmentsMap(): Map<string, MediaPeerSegmentStatus> {
        return this.segmentsMap;
    }

    public sendSegmentsMap(segmentsMap: {
        [key: string]: [string, number[]];
    }): void {
        this.sendCommand({ c: MediaPeerCommands.SegmentsMap, m: segmentsMap });
    }

    public sendSegmentData(segmentId: string, data: ArrayBuffer): void {
        this.sendCommand({
            c: MediaPeerCommands.SegmentData,
            i: segmentId,
            s: data.byteLength,
        });

        let bytesLeft = data.byteLength;
        while (bytesLeft > 0) {
            const bytesToSend =
                bytesLeft >= this.settings.webRtcMaxMessageSize
                    ? this.settings.webRtcMaxMessageSize
                    : bytesLeft;
            const buffer = Buffer.from(
                data,
                data.byteLength - bytesLeft,
                bytesToSend
            );

            this.peer.write(buffer);
            bytesLeft -= bytesToSend;
        }

        this.emit("bytes-uploaded", this, data.byteLength);
    }

    public sendSegmentAbsent(segmentId: string): void {
        this.sendCommand({ c: MediaPeerCommands.SegmentAbsent, i: segmentId });
    }

    public requestSegment(segmentId: string): void {
        if (this.downloadingSegmentId) {
            throw new Error(
                "A segment is already downloading: " + this.downloadingSegmentId
            );
        }

        this.sendCommand({ c: MediaPeerCommands.SegmentRequest, i: segmentId });
        this.downloadingSegmentId = segmentId;
        this.runResponseTimeoutTimer();
    }

    public cancelSegmentRequest(): ArrayBuffer[] | undefined {
        let downloadingSegment: ArrayBuffer[] | undefined;

        if (this.downloadingSegmentId) {
            const segmentId = this.downloadingSegmentId;
            downloadingSegment = this.downloadingSegment
                ? this.downloadingSegment.pieces
                : undefined;
            this.terminateSegmentRequest();
            this.sendCommand({
                c: MediaPeerCommands.CancelSegmentRequest,
                i: segmentId,
            });
        }

        return downloadingSegment;
    }

    private runResponseTimeoutTimer(): void {
        this.timer = setTimeout(() => {
            this.timer = null;
            if (!this.downloadingSegmentId) {
                return;
            }
            const segmentId = this.downloadingSegmentId;
            this.cancelSegmentRequest();
            this.emit("segment-timeout", this, segmentId); // TODO: send peer not responding event
        }, this.settings.p2pSegmentDownloadTimeout);
    }

    private cancelResponseTimeoutTimer(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    private terminateSegmentRequest() {
        this.downloadingSegmentId = null;
        this.downloadingSegment = null;
        this.cancelResponseTimeoutTimer();
    }
}
