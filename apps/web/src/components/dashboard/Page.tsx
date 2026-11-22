import type { ReactNode } from "react";

/** The frame the Developer and session pages share: an optional side nav beside a heading and the page's panels. */
export function Page({ title, intro, end, nav, crumb, children }: { readonly title: ReactNode; readonly intro: ReactNode; readonly end?: ReactNode; readonly nav?: ReactNode; readonly crumb?: ReactNode; readonly children: ReactNode }) {
  return (
    <div className="dev">
      <div className={nav ? "dshell" : "dshell wide"}>
        {nav}
        <div className="dmain">
          {crumb}
          <div className="pagehead">
            <div>
              <h1>{title}</h1>
              {intro ? <p>{intro}</p> : null}
            </div>
            {end}
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
