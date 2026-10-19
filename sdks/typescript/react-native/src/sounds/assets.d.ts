// Metro resolves an imported audio file to an asset id that expo-audio plays.
declare module "*.wav" {
  const asset: number;
  export default asset;
}
