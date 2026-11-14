import { Link, useNavigate } from "@tanstack/react-router";
import { type HomeCallDTO, type LiveDTO } from "../../lib/dashboard/contracts";
import { lastActive, shareableLink } from "../../lib/dashboard/format";
import { Faces } from "../site/Avatar";
import { CopyAction, LinkText, usePhone, useToast } from "./kit";
import { Menu, MenuItem, RenameArchiveItems } from "./menu";
import { inviteLink } from "./home-rows";

export function CallRow({ call, live, onRename, onArchive }: { readonly call: HomeCallDTO; readonly live: LiveDTO["episode"]; readonly onRename: () => void; readonly onArchive: () => void }) {
  const phone = usePhone();
  const navigate = useNavigate();
  const join = () => void navigate({ to: "/dashboard/call/$spaceId/join", params: { spaceId: call.id } });
  const status = live ? (
    <span className="live">
      <span className="dot" />
      Live · {live.count} in the call
    </span>
  ) : (
    lastActive(call.lastActiveAt ?? call.createdAt)
  );
  const label = live ? `${call.name}, live now with ${live.count} people` : `${call.name}, last active ${lastActive(call.lastActiveAt ?? call.createdAt)}`;
  const faces = live ? live.participants.map((person) => person.name) : call.recentPeople.map((person) => person.name);
  // The faces column holds three circles; when people overflow it, the count takes the last one.
  const shown = faces.length > 3 ? 2 : 3;
  return (
    <div className="row">
      <Link className="ra" to="/dashboard/call/$spaceId" params={{ spaceId: call.id }} aria-label={label} />
      {/* The people come first and sit right against the name, so a row reads as who and what together. */}
      {/* A call nobody has joined keeps one quiet empty face, so its name starts where every other name does. */}
      <span className="fcol np">{faces.length ? <Faces names={faces} size={28} max={shown} /> : <span className="noface" />}</span>
      <span className="rt np">
        <b>{call.name}</b>
        {phone ? <span>{status}</span> : call.inviteUrl ? <LinkText link={shareableLink(call.inviteUrl)} className="mono" /> : null}
      </span>
      {phone ? null : <span className="rm np">{status}</span>}
      <span className="ract">
        {live ? (
          <button type="button" className="btn sec sm" onClick={join}>
            Join
          </button>
        ) : null}
        {phone ? null : <CopyAction text={() => inviteLink(call)} />}
        <RowMenu call={call} onJoin={join} onRename={onRename} onArchive={onArchive} />
      </span>
    </div>
  );
}

function RowMenu({ call, onJoin, onRename, onArchive }: { readonly call: HomeCallDTO; readonly onJoin: () => void; readonly onRename: () => void; readonly onArchive: () => void }) {
  const phone = usePhone();
  return (
    <Menu label={`More actions for ${call.name}`}>
      {(close) => (
        <>
          <MenuItem
            icon="cam"
            onSelect={() => {
              close();
              onJoin();
            }}
          >
            Join call
          </MenuItem>
          {phone ? <CopyMenuItem call={call} onDone={close} /> : null}
          <RenameArchiveItems close={close} onRename={onRename} onArchive={onArchive} archiveIcon="archive" />
        </>
      )}
    </Menu>
  );
}

function CopyMenuItem({ call, onDone }: { readonly call: HomeCallDTO; readonly onDone: () => void }) {
  const toast = useToast();
  return (
    <MenuItem
      icon="copy"
      onSelect={() => {
        onDone();
        inviteLink(call)
          .then((link) => navigator.clipboard.writeText(link))
          .then(
            () => toast("Link copied"),
            () => toast("Couldn’t copy the link. Open the call to copy it.", { icon: "alert" }),
          );
      }}
    >
      Copy link
    </MenuItem>
  );
}
