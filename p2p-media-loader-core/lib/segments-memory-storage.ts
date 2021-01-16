import { Segment } from "./loader-interface";
import { SegmentsStorage } from "./hybrid-loader";

export class SegmentsMemoryStorage implements SegmentsStorage {
    private cache: Map<
        string,
        { segment: Segment; lastAccessed: number }
    > = new Map();

    constructor(
        private settings: {
            cachedSegmentExpiration: number;
            cachedSegmentsCount: number;
        }
    ) {}

    public async storeSegment(segment: Segment) {
        this.cache.set(segment.id, {
            segment,
            lastAccessed: performance.now(),
        });
    }

    public async getSegmentsMap(masterSwarmId: string) {
        return this.cache;
    }

    public async getSegment(id: string, masterSwarmId: string) {
        const cacheItem = this.cache.get(id);

        if (cacheItem === undefined) {
            return undefined;
        }

        cacheItem.lastAccessed = performance.now();
        return cacheItem.segment;
    }

    public async hasSegment(id: string, masterSwarmId: string) {
        return this.cache.has(id);
    }

    public async clean(
        masterSwarmId: string,
        lockedSementsfilter?: (id: string) => boolean
    ) {
        const segmentsToDelete: string[] = [];
        const remainingSegments: {
            segment: Segment;
            lastAccessed: number;
        }[] = [];

        // Delete old segments
        const now = performance.now();

        for (const cachedSegment of this.cache.values()) {
            if (
                now - cachedSegment.lastAccessed >
                this.settings.cachedSegmentExpiration
            ) {
                segmentsToDelete.push(cachedSegment.segment.id);
            } else {
                remainingSegments.push(cachedSegment);
            }
        }

        // Delete segments over cached count
        let countOverhead =
            remainingSegments.length - this.settings.cachedSegmentsCount;
        if (countOverhead > 0) {
            remainingSegments.sort((a, b) => a.lastAccessed - b.lastAccessed);

            for (const cachedSegment of remainingSegments) {
                if (
                    lockedSementsfilter === undefined ||
                    !lockedSementsfilter(cachedSegment.segment.id)
                ) {
                    segmentsToDelete.push(cachedSegment.segment.id);
                    countOverhead--;
                    if (countOverhead == 0) {
                        break;
                    }
                }
            }
        }

        segmentsToDelete.forEach((id) => this.cache.delete(id));
        return segmentsToDelete.length > 0;
    }

    public async destroy() {
        this.cache.clear();
    }
}
