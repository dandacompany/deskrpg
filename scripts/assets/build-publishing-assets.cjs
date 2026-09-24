// Generate the publishing props and the measurement report together through the shared export.
const { buildAuthoredAssets } = require("./build-tech-startup.cjs");
buildAuthoredAssets({
  output: "public/assets/shared/publishing",
  woodColors: ["#a98150"],
  module: "./src/game/three/publishing-assets",
  builder: "buildPublishingAsset",
  definitions: "PUBLISHING_ASSETS",
  generator: "scripts/assets/build-publishing-assets.cjs",
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
