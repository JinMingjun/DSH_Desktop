/**
 * The model-facing `bilibili_frames` tool: sample a video's real frames and
 * return them as image blocks so an image-capable model can "watch" a video
 * instead of relying on subtitles alone.
 *
 * Two frame sources, tried in order by `auto` mode:
 * - the player API's preview sprite (`preview_pic`): one JPEG carrying a grid
 *   of sampled frames — zero download, zero host dependencies;
 * - the video cover image as a single-frame fallback.
 *
 * `extract` mode downloads the direct mp4 and runs ffmpeg to produce evenly
 * spaced PNG frames; it requires ffmpeg on PATH and is capped by the
 * deployment's per-message image limits.
 *
 * The tool strictly gates on the calling route's declared image input (the
 * same rule as `read_image`) and on the mounted attachments service.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment';
import type { BilibiliProviderLike } from './types.ts';
/**
 * The message kind this package owns for the frames it injects.
 *
 * `MessageSourceMap` is merge-extensible: every producer declares its own
 * `kind` in its own module, and consumers fall through kinds they do not know.
 * Harness 0.1.7 removed the shared catch-all `plugin` kind this plugin used to
 * carry, so the deferred frames context now names itself instead. The
 * declaration merges on 0.1.6 too, where a private kind is equally valid, so a
 * single build serves both lines.
 */
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        /** Real video frames a `bilibili_frames` call attached to its own turn. */
        'bilibili-frames': {
            kind: 'bilibili-frames';
        };
    }
}
/** Default frame count for `extract` mode. */
export declare const BILIBILI_FRAMES_DEFAULT_COUNT = 8;
/** Upper bound on requested frames; the per-message image cap still applies. */
export declare const BILIBILI_FRAMES_MAX_COUNT = 12;
/** The modes `bilibili_frames` accepts. */
export declare const FRAME_MODES: readonly ["auto", "extract"];
export type BilibiliFrameMode = (typeof FRAME_MODES)[number];
/** Validated `bilibili_frames` arguments. */
export interface BilibiliFramesArgs {
    bvid: string;
    mode: BilibiliFrameMode;
    count: number;
}
/** One committed frame image in a `bilibili_frames` outcome. */
export interface BilibiliFrameImage {
    attachmentId: string;
    mediaType: ImageMediaType;
    bytes: number;
    width: number;
    height: number;
    name?: string;
}
/** The tool output value: committed frame images plus provenance. */
export interface BilibiliFramesValue {
    images: BilibiliFrameImage[];
    meta: {
        bvid: string;
        title: string;
        source: 'preview' | 'cover' | 'extract';
    };
}
/**
 * Validate `bilibili_frames` arguments: a non-blank bvid, a known mode,
 * and a bounded integer frame count.
 * @param args - the schema-validated tool arguments.
 * @returns the accepted arguments with defaults filled.
 */
export declare function parseFramesArgs(args: {
    bvid?: string;
    mode?: string;
    count?: number;
}): BilibiliFramesArgs;
/**
 * Register the `bilibili_frames` tool. The composing plugin owns the
 * attachments gate: `src/index.ts` calls this inside
 * `ctx.inject(['attachments'], …)` so the tool exists only while a durable
 * store is mounted. Execution still re-checks the attachments service for
 * direct callers and gates on the calling route's declared image input.
 * @param ctx - the registration scope; execution uses the `attachments` and
 *   `llm` services plus the provider instance.
 * @param service - the provider instance the tool executes against.
 * @param timeoutMs - the cooperative tool-call budget (ms).
 */
export declare function applyBilibiliFramesTool(ctx: Context, service: BilibiliProviderLike, timeoutMs: number): void;
