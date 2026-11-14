import { Fragment, type ReactNode } from "react";

export type LegalSection = { heading: string; content: string };
export type LegalEntry = { label: string; text: string };
export type CookieRow = { cookie: ReactNode; purpose: string; lifetime: string };

export function LegalSections({ sections }: { sections: readonly LegalSection[] }) {
  return sections.map(({ heading, content }) => (
    <Fragment key={heading}>
      <h2>{heading}</h2>
      <p>{content}</p>
    </Fragment>
  ));
}

export function LegalEntries({ entries }: { entries: readonly LegalEntry[] }) {
  return entries.map(({ label, text }) => (
    <p key={label}>
      <strong>{label}</strong> {text}
    </p>
  ));
}

export function CookieTable({ rows }: { rows: readonly CookieRow[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th scope="col">Cookie</th>
          <th scope="col">Purpose</th>
          <th scope="col">Lifetime</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ cookie, purpose, lifetime }) => (
          <tr key={purpose}>
            <td>{cookie}</td>
            <td>{purpose}</td>
            <td>{lifetime}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
