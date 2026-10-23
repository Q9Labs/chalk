import { execFileSync } from "node:child_process";
const oldBase = "c48de517a309d34cd1c625a9ee1402348951f0a4";
const oldHead = "18f216766acac609b5570a9baba1acc17a19b93d";
const newBase = "2a2fdf9bcb6c4d10f28b769e2a19deda325f7b7f";
const newHead = process.argv[2] ?? "HEAD";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const count = (base, head, paths = []) =>
  git("diff", "--numstat", base, head, ...(paths.length ? ["--", ...paths] : []))
    .split("\n")
    .filter(Boolean)
    .reduce(
      (result, line) => {
        const [add, del] = line.split("\t");
        if (add !== "-") {
          result.added += Number(add);
          result.deleted += Number(del);
        }
        return result;
      },
      { added: 0, deleted: 0 },
    );
const paths = [...new Set([...git("diff", "--name-only", oldBase, oldHead).split("\n"), ...git("diff", "--name-only", newBase, newHead).split("\n")])];
console.log(
  JSON.stringify(
    {
      oldProposal: count(oldBase, oldHead),
      replacement: count(newBase, newHead),
      directAgainst400: count(oldHead, newHead),
      bothFeaturePathSets: count(oldHead, newHead, paths),
      notes: ["Binary files do not contribute line counts.", "Direct comparison includes unrelated changes on master between proposals.", "Feature path sets exclude other paths, but can include master changes within shared paths."],
    },
    null,
    2,
  ),
);
