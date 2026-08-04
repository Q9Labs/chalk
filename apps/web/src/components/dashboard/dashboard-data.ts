export type SpaceSummary = {
  id: string;
  name: string;
  description: string;
  accent: "green" | "blue" | "yellow" | "pink";
  currentEpisode: "In progress" | "None";
  lastActive: string;
};

export const spaces: SpaceSummary[] = [
  {
    id: "product-studio",
    name: "Product studio",
    description: "Weekly critiques, focused work, and product decisions.",
    accent: "green",
    currentEpisode: "In progress",
    lastActive: "Active now",
  },
  {
    id: "research-lab",
    name: "Research lab",
    description: "Customer conversations and synthesis with the research team.",
    accent: "blue",
    currentEpisode: "None",
    lastActive: "Yesterday",
  },
  {
    id: "company-campfire",
    name: "Company campfire",
    description: "A durable home for all-hands Episodes and shared context.",
    accent: "yellow",
    currentEpisode: "None",
    lastActive: "3 days ago",
  },
];

export const recentEpisodes = [
  { title: "Monday product critique", space: "Product studio", when: "Today · 42 min" },
  { title: "Research synthesis", space: "Research lab", when: "Yesterday · 58 min" },
  { title: "July campfire", space: "Company campfire", when: "Jul 28 · 35 min" },
];

export const recentArtifacts = [
  { title: "Product critique notes", kind: "Notes", when: "Edited 18 min ago" },
  { title: "Research synthesis transcript", kind: "Transcript", when: "Ready yesterday" },
];
