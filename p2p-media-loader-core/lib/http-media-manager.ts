import { STEEmitter } from "./stringly-typed-event-emitter";
import { Segment } from "./loader-interface";
import {
    SegmentUrlBuilder,
    SegmentValidatorCallback,
    XhrSetupCallback,
} from "./hybrid-loader";

export class HttpMediaManager extends STEEmitter<
    "segment-loaded" | "segment-error" | "bytes-downloaded"
> {
    private xhrRequests: Map<
        string,
        { xhr: XMLHttpRequest; segment: Segment }
    > = new Map();
    private failedSegments: Map<string, number> = new Map();

    public constructor(
        readonly settings: {
            // 尝试失败后尝试通过HTTP再次加载段之前的超时时间（以毫秒为单位）
            httpFailedSegmentTimeout: number;
            // 使用HTTP进行加载的范围
            httpUseRanges: boolean;
            // 片段验证
            segmentValidator?: SegmentValidatorCallback;
            // xhr请求回调
            xhrSetup?: XhrSetupCallback;
            // 细分网址函数
            segmentUrlBuilder?: SegmentUrlBuilder;
        }
    ) {
        super();
    }

    public download(segment: Segment, downloadedPieces?: ArrayBuffer[]): void {
        // 判断当前片段是否在下载
        // this.isDownloading(segment);
        if (this.xhrRequests.has(segment.id)) return;

        // 清除失败的片段
        // this.cleanTimedOutFailedSegments();
        const now = performance.now();
        const candidates: string[] = [];
        this.failedSegments.forEach((time, id) => {
            if (time < now) candidates.push(id);
        });
        candidates.forEach((id) => this.failedSegments.delete(id));

        // 获取片段Url，可使用自定义的片段构建函数
        const segmentUrl = this.settings.segmentUrlBuilder
            ? this.settings.segmentUrlBuilder(segment)
            : segment.url;
        segment.requestUrl = segmentUrl;

        // 请求片段Url
        const xhr = new XMLHttpRequest();
        xhr.open("GET", segmentUrl, true);
        xhr.responseType = "arraybuffer";

        // 可选，设置Range请求头，用于获取指定范围的数据
        // 能正常响应时返回206，不能处理Range时返回整个资源和200状态码
        if (segment.range) {
            xhr.setRequestHeader("Range", segment.range);
            downloadedPieces = undefined; // TODO: process downloadedPieces for segments with range headers too
        } else if (
            // 如果已下载的数据不为空，且要求进行指定数据量的切片
            downloadedPieces !== undefined &&
            this.settings.httpUseRanges
        ) {
            // 计算已下载的数据字节数
            let bytesDownloaded = 0;
            for (const piece of downloadedPieces) {
                bytesDownloaded += piece.byteLength;
            }
            // 设置Range头
            xhr.setRequestHeader("Range", `bytes=${bytesDownloaded}-`);
        } else {
            // 如果没有要求进行数据切片
            downloadedPieces = undefined;
        }

        // 发起xhr请求
        this.setupXhrEvents(xhr, segment, downloadedPieces);

        // 返回当前创建的xhr给外部
        if (this.settings.xhrSetup) this.settings.xhrSetup(xhr, segmentUrl);

        this.xhrRequests.set(segment.id, { xhr, segment });
        xhr.send();
    }

    public abort(segment: Segment): void {
        const request = this.xhrRequests.get(segment.id);

        if (request) {
            request.xhr.abort();
            this.xhrRequests.delete(segment.id);
        }
    }

    public isDownloading(segment: Segment): boolean {
        return this.xhrRequests.has(segment.id);
    }

    public isFailed(segment: Segment): boolean {
        const time = this.failedSegments.get(segment.id);
        return time !== undefined && time > this.now();
    }

    public getActiveDownloads(): ReadonlyMap<string, { segment: Segment }> {
        return this.xhrRequests;
    }

    public getActiveDownloadsCount(): number {
        return this.xhrRequests.size;
    }

    public destroy(): void {
        this.xhrRequests.forEach((request) => request.xhr.abort());
        this.xhrRequests.clear();
    }

    private setupXhrEvents(
        xhr: XMLHttpRequest,
        segment: Segment,
        downloadedPieces?: ArrayBuffer[]
    ) {
        // 每次接收到请求的时候都对外暴露当前下载的字节数
        let prevBytesLoaded = 0;
        xhr.addEventListener("progress", (event: any) => {
            const bytesLoaded = event.loaded - prevBytesLoaded;
            this.emit("bytes-downloaded", bytesLoaded);
            prevBytesLoaded = event.loaded;
        });

        // 请求完成时触发
        xhr.addEventListener("load", async (event: any) => {
            // 处理错误情况
            if (event.target.status < 200 || event.target.status >= 300) {
                // this.segmentFailure(segment, event, xhr);
                // 返回响应的序列化URL
                segment.responseUrl =
                    xhr.responseURL === null ? undefined : xhr.responseURL;

                // 将该片段请求在请求列表中删除，然后将该片段id假如到失败片段列表中
                this.xhrRequests.delete(segment.id);
                this.failedSegments.set(
                    segment.id,
                    this.now() + this.settings.httpFailedSegmentTimeout
                );
                // 对外暴露错误
                this.emit("segment-error", segment, event);
                return;
            }

            // 请求成功时获取数据
            let data = event.target.response;

            // 如果存在已下载的数据，且服务器支持Range头，能够获取到进行分片的数据
            if (downloadedPieces !== undefined && event.target.status === 206) {
                // 获取已下载的数据的字节长度
                let bytesDownloaded = 0;
                for (const piece of downloadedPieces) {
                    bytesDownloaded += piece.byteLength;
                }

                // 创建对应长度的buffer对象
                // 这里是 分片的字节数 + 返回数据的总字节数
                const segmentData = new Uint8Array(
                    bytesDownloaded + data.byteLength
                );
                let offset = 0;
                // 将分片数据塞入buffer对象中
                // set：从源缓存对象区域拷贝数据到目标缓存对象区域
                for (const piece of downloadedPieces) {
                    segmentData.set(new Uint8Array(piece), offset);
                    offset += piece.byteLength;
                }
                segmentData.set(new Uint8Array(data), offset);
                data = segmentData.buffer;
            }

            await this.segmentDownloadFinished(segment, data, xhr);
        });

        xhr.addEventListener("error", (event: any) => {
            this.segmentFailure(segment, event, xhr);
        });

        xhr.addEventListener("timeout", (event: any) => {
            this.segmentFailure(segment, event, xhr);
        });
    }

    private async segmentDownloadFinished(
        segment: Segment,
        data: ArrayBuffer,
        xhr: XMLHttpRequest
    ) {
        segment.responseUrl =
            xhr.responseURL === null ? undefined : xhr.responseURL;

        if (this.settings.segmentValidator) {
            try {
                await this.settings.segmentValidator(
                    { ...segment, data: data },
                    "http"
                );
            } catch (error) {
                this.segmentFailure(segment, error, xhr);
                return;
            }
        }

        this.xhrRequests.delete(segment.id);
        this.emit("segment-loaded", segment, data);
    }

    private segmentFailure(segment: Segment, error: any, xhr: XMLHttpRequest) {
        segment.responseUrl =
            xhr.responseURL === null ? undefined : xhr.responseURL;

        this.xhrRequests.delete(segment.id);
        this.failedSegments.set(
            segment.id,
            this.now() + this.settings.httpFailedSegmentTimeout
        );
        this.emit("segment-error", segment, error);
    }

    private cleanTimedOutFailedSegments() {
        const now = this.now();
        const candidates: string[] = [];

        this.failedSegments.forEach((time, id) => {
            if (time < now) {
                candidates.push(id);
            }
        });

        candidates.forEach((id) => this.failedSegments.delete(id));
    }

    private now = () => performance.now();
}
