import { Icon, type IconName } from "../site/Icon";

export type Fact = { readonly icon: IconName; readonly title: string; readonly line: string };

/** A short list of claims, each with an icon, a bold title and one muted line. */
export function Facts({ facts, flush = false }: { readonly facts: readonly Fact[]; readonly flush?: boolean }) {
  return (
    <ul className={flush ? "facts flush" : "facts"}>
      {facts.map((fact) => (
        <li key={fact.title}>
          <Icon name={fact.icon} />
          <div>
            <b>{fact.title}</b>
            <span>{fact.line}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
