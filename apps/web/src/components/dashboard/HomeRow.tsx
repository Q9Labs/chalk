import { Link, useNavigate } from "@tanstack/react-router";
import { type HomeCallDTO, type LiveDTO } from "../../lib/dashboard/contracts";
import { displayLink, lastActive } from "../../lib/dashboard/format";
import { Faces } from "../site/Avatar";
import { CopyAction, Menu, MenuItem, usePhone, useToast } from "./kit";
import { inviteLink } from "./home-rows";

function CallRow({ call, live, onRename, onArchive }: { readonly call: HomeCallDTO; readonly live: LiveDTO["episode"]; readonly onRename: () => void; readonly onArchive: () => void }) {
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
  return (
    <div className="row">
      <Link className="ra" to="/dashboard/call/$spaceId" params={{ spaceId: call.id }} aria-label={label} />
      <span className="rt np">
        <b>{call.name}</b>
        {phone ? <span>{status}</span> : call.inviteUrl ? <span className="mono">{displayLink(call.inviteUrl)}</span> : null}
      </span>
      {faces.length ? (
        <span className="fcol np">
          <Faces names={faces} size={28} max={phone ? 2 : 3} />
        </span>
      ) : null}
      {phone ? null : <span className="rm np">{status}</span>}
      <span className="ract">
        {live ? (
          <button type="button" className="btn sec sm" onClick={join}>
            Join
          </button>
        ) : null}
        {phone ? null : <CopyAction text={() => inviteLink(call)} />}
        <Menu label={`More actions for ${call.name}`}>
          {(close) => (
            <>
              <MenuItem
                icon="cam"
                onSelect={() => {
                  close();
                  join();
                }}
              >
                Join call
              </MenuItem>
              <CopyMenuItem call={call} onDone={close} />
              <MenuItem
                icon="edit"
                onSelect={() => {
                  close();
                  onRename();
                }}
              >
                Rename
              </MenuItem>
              <div className="msep" />
              <MenuItem
                icon="trash"
                danger
                onSelect={() => {
                  close();
                  onArchive();
                }}
              >
                Archive call
              </MenuItem>
            </>
          )}
        </Menu>
      </span>
    </div>
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

