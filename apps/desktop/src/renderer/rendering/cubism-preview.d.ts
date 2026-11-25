declare module 'virtual:pet-desktop-cubism-sdk' {
  export const preview: {
    readonly core: string;
    readonly shaders: string;
    load(): Promise<import('./cubism-runtime').CubismSdkBindings>;
  } | null;
}
