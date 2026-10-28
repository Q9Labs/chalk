import ts from "typescript";

const namedColors = "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen".split(" ").join("|");
export const colorProperty = "(?:background(?:Color)?|border[\\w-]*(?:Color|color)?|color|fill|stroke|stopColor|stop-color|outlineColor|outline-color|shadowColor|textDecorationColor|tintColor|placeholderTextColor|selectionColor|underlayColor|thumbColor)";
export const namedColorPattern = new RegExp(`(?<![\\w-])["']?${colorProperty}["']?\\s*(?::|=)\\s*\\{?\\s*["']?(?:${namedColors})(?![\\w-])`, "giu");
export const literalColorPattern = /(?<![\w/#?=&-])#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})(?![\w-])|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/giu;

// Preserve offsets, including line numbers, while removing comments and non-color URL fragments.
export function colorSource(source, file) {
  const ranges = [];
  const add = (start, end) => ranges.push([start, end]);
  if (file.endsWith(".css")) {
    for (const match of source.matchAll(/\/\*[\s\S]*?\*\//gu)) add(match.index, match.index + match[0].length);
  } else {
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node) => {
      for (const range of ts.getLeadingCommentRanges(source, node.pos) ?? []) add(range.pos, range.end);
      for (const range of ts.getTrailingCommentRanges(source, node.end) ?? []) add(range.pos, range.end);
      if (ts.isRegularExpressionLiteral(node) || (ts.isJsxAttribute(node) && ["href", "id"].includes(node.name.getText(tree)))) add(node.getStart(tree), node.end);
      if (ts.isTemplateLiteralToken(node)) {
        const text = source.slice(node.getStart(tree), node.end);
        for (const match of text.matchAll(/\/\*[\s\S]*?\*\//gu)) add(node.getStart(tree) + match.index, node.getStart(tree) + match.index + match[0].length);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  for (const match of source.matchAll(/url\([^)]*\)|https?:\/\/[^\s"'`<>]+/giu)) add(match.index, match.index + match[0].length);
  const chars = source.split("");
  for (const [start, end] of ranges) for (let index = start; index < end; index++) if (chars[index] !== "\n" && chars[index] !== "\r") chars[index] = " ";
  return chars.join("");
}
