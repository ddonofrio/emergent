declare module 'fastnoise-lite' {
  type NoiseType='OpenSimplex2'|'OpenSimplex2S'|'Cellular'|'Perlin'|'ValueCubic'|'Value';
  type FractalType='None'|'FBm'|'Ridged'|'PingPong'|'DomainWarpProgressive'|'DomainWarpIndependent';

  export default class FastNoiseLite {
    static readonly NoiseType:Readonly<Record<NoiseType,NoiseType>>;
    static readonly FractalType:Readonly<Record<FractalType,FractalType>>;
    constructor(seed?:number);
    SetFrequency(frequency:number):void;
    SetNoiseType(type:NoiseType):void;
    SetFractalType(type:FractalType):void;
    SetFractalOctaves(octaves:number):void;
    SetFractalGain(gain:number):void;
    SetFractalLacunarity(lacunarity:number):void;
    GetNoise(x:number,y:number,z?:number):number;
  }
}
