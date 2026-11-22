const path = require('node:path');
const {getDefaultConfig,mergeConfig} = require('@react-native/metro-config');
const workspace = path.resolve(__dirname,'../..');
module.exports = mergeConfig(getDefaultConfig(__dirname),{
  watchFolders:[path.join(workspace,'packages'),path.join(workspace,'node_modules')],
  resolver:{nodeModulesPaths:[path.join(workspace,'node_modules')]},
});
