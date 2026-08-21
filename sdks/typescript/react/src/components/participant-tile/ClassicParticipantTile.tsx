import React from "react";

import { SkinProvider } from "../skin-context";
import { ParticipantTile, type ParticipantTileProps } from "./ParticipantTile";

/** The participant tile pinned to the classic skin, regardless of the surrounding skin. */
export const ClassicParticipantTile = React.memo(function ClassicParticipantTile(props: ParticipantTileProps) {
  return (
    <SkinProvider skin="classic">
      <ParticipantTile {...props} />
    </SkinProvider>
  );
});

ClassicParticipantTile.displayName = "ClassicParticipantTile";
