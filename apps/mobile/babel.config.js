module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    plugins: [transformEffectImportMeta],
  };
};

function transformEffectImportMeta({ types }) {
  return {
    name: "transform-effect-import-meta",
    visitor: {
      MetaProperty(path, state) {
        if (!state.filename?.includes("/effect/") || path.node.meta.name !== "import" || path.node.property.name !== "meta") return;
        path.replaceWith(types.objectExpression([]));
      },
    },
  };
}
