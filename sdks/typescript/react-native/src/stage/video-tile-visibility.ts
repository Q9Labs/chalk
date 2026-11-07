import { setVideoTileVisibility, type SpaceSnapshot } from "@q9labsai/chalk-client";
import { useEffect, useMemo, useRef } from "react";
import { PixelRatio } from "react-native";
import type { SharedContent } from "./ContentTile";
import type { StageItem } from "./layout";
import { useSpaceSelector } from "./space-selector";

/** Each remote video publication as "participant, source, publication" lines, so the selector compares one string. */
function selectRemoteVideo(snapshot: SpaceSnapshot): string {
  const selfId = snapshot.self.participantId;
  const lines: string[] = [];
  for (const person of snapshot.participants.roster) {
    if (person.participantId === selfId) continue;
    if (person.media.cameraPublicationId) lines.push(`${person.participantId}\tcamera\t${person.media.cameraPublicationId}`);
    if (person.media.screenSharePublicationId) lines.push(`${person.participantId}\tscreen\t${person.media.screenSharePublicationId}`);
  }
  return lines.join("\n");
}

/**
 * Reports which remote cameras and screens have a tile on the stage, so the media client pulls only that video.
 * People past the "+N" tile, and a screen behind the board, are reported hidden.
 */
export function useStageVideoTiles(items: readonly StageItem[], content: SharedContent | null): void {
  const remoteVideo = useSpaceSelector(selectRemoteVideo);
  const reports = useMemo(() => {
    const scale = PixelRatio.get();
    const onStage = new Map<string, { readonly width: number; readonly height: number }>();
    for (const item of items) {
      if (item.kind === "person") onStage.set(`${item.id}\tcamera`, { width: item.frame.width * scale, height: item.frame.height * scale });
      if (item.kind === "content" && content?.kind === "screen") onStage.set(`${content.sharerId}\tscreen`, { width: item.inner.width * scale, height: item.inner.height * scale });
    }
    return remoteVideo
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [participantId, source, publicationId] = line.split("\t");
        return { publicationId: publicationId!, size: onStage.get(`${participantId}\t${source}`) ?? null };
      });
  }, [content, items, remoteVideo]);
  const reported = useRef(new Set<string>());

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-ts -- [resource] Publish stage tile visibility to the media client's pull policy after commit.
  useEffect(() => {
    for (const { publicationId, size } of reports) {
      reported.current.add(publicationId);
      setVideoTileVisibility(publicationId, size);
    }
  }, [reports]);

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-ts -- [resource] Report every tile hidden when the stage unmounts, so its video is closed.
  useEffect(
    () => () => {
      for (const publicationId of reported.current) setVideoTileVisibility(publicationId, null);
    },
    [],
  );
}
