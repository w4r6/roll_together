// @ts-check
const path = require("path");
const CopyPlugin = require("copy-webpack-plugin");
const webpack = require("webpack");

// Environment variables
/** @typedef {{SYNC_SERVER: string}} EnvJson */
/** @typedef {{development: EnvJson, production: EnvJson}} EnvJsonFile */
/** @type {EnvJsonFile} */
const envVariables = require("./env.json");

module.exports = (env) => {
  const isFirefox = Boolean(env.firefox);
  const isProduction = Boolean(env.production);
  const outputDir = isFirefox ? "build-firefox" : "build";
  const environment = isProduction ? "production" : "development";
  const syncServer = envVariables[environment].SYNC_SERVER;
  const baseManifest = require("./manifest.base.json");
  const targetManifest = require(
    isFirefox ? "./manifest.firefox.json" : "./manifest.chrome.json",
  );
  const manifest = {
    ...baseManifest,
    ...targetManifest,
    host_permissions: [
      ...baseManifest.host_permissions,
      `${new URL(syncServer).origin}/*`,
    ],
  };

  /** @type {webpack.Configuration} */
  const config = {
    mode: isProduction ? "production" : "development",
    entry: {
      service_worker: "./src/service_worker.ts",
      content_script: "./src/content_script.ts",
      popup: "./src/popup.ts",
      options: "./src/options.ts",
    },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          use: "ts-loader",
          exclude: /node_modules/,
        },
      ],
    },
    resolve: {
      extensions: [".tsx", ".ts", ".js"],
    },
    output: {
      filename: "[name].js",
      path: path.resolve(__dirname, outputDir),
      clean: true,
    },
    optimization: { concatenateModules: false, minimize: isProduction },
    devtool: isProduction ? false : "inline-source-map",
    plugins: [
      new CopyPlugin({
        patterns: [
          {
            from: "manifest.base.json",
            to: "manifest.json",
            transform: () => `${JSON.stringify(manifest, null, 2)}\n`,
          },
          { from: "src/images", to: "images" },
          { from: "src/options.html" },
          { from: "src/popup.html" },
          { from: "src/styles.css" },
        ],
      }),
      new webpack.DefinePlugin({
        "typeof self": JSON.stringify("object"),
      }),
      new webpack.EnvironmentPlugin({ SYNC_SERVER: syncServer }),
    ],
  };

  return config;
};
