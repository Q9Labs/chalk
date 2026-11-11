import type { ReactNode } from "react";

import { Icon, type IconName } from "../site/Icon";

/** The frame the Developer, Sessions and Recordings pages share: an optional side nav beside a heading and the page's panels. */
export function Page({ icon, title, intro, end, nav, crumb, children }: { readonly icon: IconName; readonly title: string; readonly intro: string; readonly end?: ReactNode; readonly nav?: ReactNode; readonly crumb?: ReactNode; readonly children: ReactNode }) {
  return (
    <div className="dev">
      <div className={nav ? "dshell" : "dshell wide"}>
        {nav}
        <div className="dmain">
          {crumb}
          <div className="pagehead">
            <span className="tile">
              <Icon name={icon} size={20} />
            </span>
            <div>
              <h1>{title}</h1>
              <p>{intro}</p>
            </div>
            {end}
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

export function Stat({ icon, label, value, children }: { readonly icon: IconName; readonly label: string; readonly value: ReactNode; readonly children: ReactNode }) {
  return (
    <div className="stat">
      <div className="l">
        <Icon name={icon} size={14} />
        {label}
      </div>
      <div className="v">{value}</div>
      <div className="s">{children}</div>
    </div>
  );
}
