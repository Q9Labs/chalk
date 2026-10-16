import { ClassicParticipantOptionsMenu } from "./ClassicParticipantOptionsMenu";
import { type ParticipantOptionsMenuProps } from "./participant-options-menu-contract";

export { runParticipantAction, type ParticipantOptionsMenuProps } from "./participant-options-menu-contract";

export function ParticipantOptionsMenu(props: ParticipantOptionsMenuProps) {
  return <ClassicParticipantOptionsMenu {...props} />;
}
