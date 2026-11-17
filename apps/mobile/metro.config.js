// Metro configuration for a workspace package.
//
// The app depends on shared packages (`@bankbuddy/contracts`) that live outside `apps/mobile`, and the
// dependencies themselves are hoisted to the repository root. Metro therefore has to watch the
// workspace root and look for modules in both node_modules folders.
const path = require("path");

const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.projectRoot = projectRoot;
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

module.exports = config;
