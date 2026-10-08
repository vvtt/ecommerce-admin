import { useState } from "react";
import { AlertTriangle, ExternalLink, ImageOff } from "lucide-react";
import { Badge } from "@/src/components/ui/badge";
import { IMAGE_KIND_META } from "@/src/lib/labels";
import { formatInt } from "@/src/lib/format";
import { cn } from "@/src/lib/utils";
import type { ImageKind, SourcingImage } from "@/src/types";

const KINDS: ImageKind[] = ["main", "detail", "sku"];

/**
 * 图片墙：按用途分组展示转存结果。
 *
 * 失败的图片不会藏起来 —— 恰恰相反，它必须显眼。转存失败通常意味着
 * 防盗链拦了或者源图挂了，用户需要知道"这条货源的图不全"，
 * 而不是看到一个少了几张的图墙却以为本来就这么多。
 */
export function SourcingImages({ images }: { images: SourcingImage[] }) {
  const [broken, setBroken] = useState<Record<string, boolean>>({});

  if (!images.length) {
    return (
      <p className="px-4 py-8 text-center text-xs text-slate-400">
        这条货源没有采集到任何图片。
      </p>
    );
  }

  return (
    <div className="space-y-4 p-4">
      {KINDS.map((kind) => {
        const group = images.filter((img) => img.kind === kind);
        if (!group.length) return null;
        const okCount = group.filter((img) => img.status === "ok").length;

        return (
          <div key={kind}>
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-xs font-bold text-slate-700">
                {IMAGE_KIND_META[kind].label}
              </h3>
              <span className="text-[11px] text-slate-400 tabular-nums">
                {okCount}/{group.length} 已转存
              </span>
            </div>

            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
              {group.map((img) => (
                <ImageTile
                  key={img.id}
                  image={img}
                  broken={!!broken[img.id]}
                  onBroken={() => setBroken((prev) => ({ ...prev, [img.id]: true }))}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ImageTile({
  image,
  broken,
  onBroken,
}: {
  image: SourcingImage;
  broken: boolean;
  onBroken: () => void;
}) {
  const usable = image.status === "ok" && image.localPath && !broken;

  return (
    <div className="group relative">
      <div
        className={cn(
          "relative aspect-square overflow-hidden rounded-md border bg-slate-50",
          image.status === "failed" ? "border-rose-200" : "border-slate-200"
        )}
      >
        {usable ? (
          <img
            src={image.localPath}
            alt=""
            loading="lazy"
            // 文件是源 URL 的哈希，理论上不会坏；真坏了说明磁盘被人删过，
            // 这时候要露出失败态而不是留一个裂图
            onError={onBroken}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 px-1 text-center">
            {image.status === "failed" ? (
              <>
                <AlertTriangle className="h-4 w-4 text-rose-400" />
                <span className="text-[10px] leading-tight text-rose-500">转存失败</span>
              </>
            ) : broken ? (
              <>
                <ImageOff className="h-4 w-4 text-amber-400" />
                <span className="text-[10px] leading-tight text-amber-600">文件缺失</span>
              </>
            ) : (
              <span className="text-[10px] leading-tight text-slate-400">转存中…</span>
            )}
          </div>
        )}

        {/* 悬停时露出源图链接，出问题时能直接点过去看原图还在不在 */}
        <a
          href={image.sourceUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="absolute right-1 top-1 rounded bg-black/55 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100"
          title={image.sourceUrl}
        >
          <ExternalLink className="h-3 w-3" />
        </a>

        {image.bytes !== undefined && image.status === "ok" && (
          <span className="absolute bottom-1 left-1 rounded bg-black/55 px-1 text-[10px] text-white tabular-nums">
            {formatBytes(image.bytes)}
          </span>
        )}
      </div>

      {/* 失败原因放在缩略图下方而不是塞进 hover —— 这是用户最需要看到的信息 */}
      {image.status === "failed" && image.error && (
        <p className="mt-1 line-clamp-2 text-[10px] leading-tight text-rose-500" title={image.error}>
          {image.error}
        </p>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** 图片区顶部的一行汇总，供详情页放在折叠标题上 */
export function ImageSummaryBadges({
  okCount,
  failCount,
  total,
}: {
  okCount: number;
  failCount: number;
  total: number;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <Badge variant="outline" className="tabular-nums">
        共 {formatInt(total)}
      </Badge>
      {okCount > 0 && (
        <Badge variant="success" className="tabular-nums">
          成功 {formatInt(okCount)}
        </Badge>
      )}
      {failCount > 0 && (
        <Badge variant="destructive" className="tabular-nums">
          失败 {formatInt(failCount)}
        </Badge>
      )}
    </span>
  );
}
