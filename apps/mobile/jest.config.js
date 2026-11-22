module.exports = {
  preset: '@react-native/jest-preset',
  moduleNameMapper: {'^@resonant/(.*)$': '<rootDir>/../../packages/$1/src/index.ts'},
};
