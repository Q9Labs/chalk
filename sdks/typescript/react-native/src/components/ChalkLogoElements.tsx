import Svg, { Defs, Ellipse, G, LinearGradient, Path, Stop } from "react-native-svg";

interface ChalkLogoElementsProps {
  size?: number;
}

export function ChalkLogoElements({ size = 64 }: ChalkLogoElementsProps): React.JSX.Element {
  return (
    <Svg accessibilityLabel="Chalk" height={size} viewBox="0 0 64 64" width={size}>
      <Defs>
        <LinearGradient id="chalk-green" x1="0%" x2="100%" y1="0%" y2="0%">
          <Stop offset="0%" stopColor="#C5E5C0" />
          <Stop offset="100%" stopColor="#80B879" />
        </LinearGradient>
        <LinearGradient id="chalk-yellow" x1="0%" x2="100%" y1="0%" y2="0%">
          <Stop offset="0%" stopColor="#FCEAB3" />
          <Stop offset="100%" stopColor="#D9B641" />
        </LinearGradient>
        <LinearGradient id="chalk-blue" x1="0%" x2="100%" y1="0%" y2="0%">
          <Stop offset="0%" stopColor="#B2E0F0" />
          <Stop offset="100%" stopColor="#55AAC9" />
        </LinearGradient>
        <LinearGradient id="chalk-pink" x1="0%" x2="100%" y1="0%" y2="0%">
          <Stop offset="0%" stopColor="#F8CACA" />
          <Stop offset="100%" stopColor="#D67B7B" />
        </LinearGradient>
      </Defs>
      <G scale={0.85} transform="translate(5, 5)">
        <G transform="rotate(-20 16 48)">
          <Path d="M9,16 L19,16 L20,50 A6,6 0 0 1 8,50 Z" fill="url(#chalk-green)" />
          <Ellipse cx={14} cy={16} fill="#D8ECD4" rx={5} ry={2} />
        </G>
        <G transform="rotate(-5 24 44)">
          <Path d="M19,12 L29,12 L30,50 A6,6 0 0 1 18,50 Z" fill="url(#chalk-yellow)" />
          <Ellipse cx={24} cy={12} fill="#FEF3D1" rx={5} ry={2} />
        </G>
        <G transform="rotate(25 44 20)">
          <Path d="M29,4 L39,4 L40,40 A6,6 0 0 1 28,40 Z" fill="url(#chalk-blue)" />
          <Ellipse cx={34} cy={4} fill="#D0EDF8" rx={5} ry={2} />
        </G>
        <G transform="rotate(10 44 40)">
          <Path d="M39,56 L49,56 L50,24 A6,6 0 0 0 38,24 Z" fill="url(#chalk-pink)" />
          <Ellipse cx={44} cy={56} fill="#FBE4E4" rx={5} ry={2} />
        </G>
      </G>
    </Svg>
  );
}
