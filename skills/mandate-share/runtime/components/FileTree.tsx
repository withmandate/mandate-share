import type { ComponentMeta } from "../lib/types.ts";

export interface TreeNode {
  name: string;
  note?: string;
  children?: TreeNode[];
}

export const meta: ComponentMeta = {
  name: "FileTree",
  description:
    "Annotated directory tree with mono filenames, nesting guide lines, and muted per-entry notes.",
  whenToUse:
    "Codebase tours and repo maps: where things live and what each directory or file is for. Show the slice that matters, not the whole tree.",
  whenNotToUse:
    "Flat file lists (plain markdown bullets) or how parts connect at runtime (Flow).",
  props: [
    {
      name: "items",
      type: "TreeNode[] where TreeNode = { name: string; note?: string; children?: TreeNode[] }",
      required: true,
      description:
        "Root entries. Nodes with a `children` array render as directories (trailing / is added automatically); `note` is a short muted annotation after the name.",
    },
  ],
  example: `<FileTree
  items={[
    { name: "pages", note: "project documents", children: [
      { name: "overview.md", note: "scope and review questions" },
    ] },
    { name: "assets", note: "supporting illustrations", children: [
      { name: "layout.svg" },
      { name: "checklist.svg" },
    ] },
    { name: "notes", children: [
      { name: "decisions.md", note: "approved changes and their reasons" },
    ] },
    { name: "exports", note: "copies prepared for review", children: [
      { name: "overview.html" },
    ] },
  ]}
/>`,
};

function Branch({ items }: { items: TreeNode[] }) {
  return (
    <ul className="filetree-branch">
      {items.map((node, i) => {
        const isDir = Array.isArray(node.children);
        return (
          <li key={i}>
            <span className="filetree-name" data-kind={isDir ? "dir" : "file"}>
              {node.name}
              {isDir && <span className="filetree-slash">/</span>}
            </span>
            {node.note && <span className="filetree-note">{node.note}</span>}
            {isDir && node.children!.length > 0 && <Branch items={node.children!} />}
          </li>
        );
      })}
    </ul>
  );
}

export default function FileTree({ items }: { items: TreeNode[] }) {
  return (
    <div className="filetree">
      <Branch items={items} />
    </div>
  );
}
