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
