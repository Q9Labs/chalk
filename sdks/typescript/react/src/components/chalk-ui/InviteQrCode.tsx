import { encode } from "uqr";
import { LIGHT_CHALK_THEME_TOKENS } from "../../theme";
import { roundedQrPaths } from "./invite-qr-path";

/** Modules of white around the code, the quiet zone cameras need to find it. */
const QUIET_ZONE = 4;

export default function InviteQrCode({ value }: { readonly value: string }) {
  const { data, size } = encode(value, { ecc: "M", border: 0 });
  const { modules, finders } = roundedQrPaths(data);
  const span = size + QUIET_ZONE * 2;
  return (
    <svg data-part="share-qr" role="img" aria-label="Scan to join this call" viewBox={`${-QUIET_ZONE} ${-QUIET_ZONE} ${span} ${span}`} className="chalk-invite-qr" style={{ background: LIGHT_CHALK_THEME_TOKENS.surface }}>
      <path fill={LIGHT_CHALK_THEME_TOKENS.textStrong} d={modules} />
      <path fill={LIGHT_CHALK_THEME_TOKENS.textStrong} fillRule="evenodd" d={finders} />
    </svg>
  );
}
