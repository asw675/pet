/** Literal release-time pins, inserted into the compiled Main/utility build.
 * No renderer setting, environment PATH or adjacent manifest can select an
 * executable or change the expected hash. In development absent stays null. */
interface NativeArtifactPins {
  readonly whisperCliSha256:string|null;
  readonly sapiHelperSha256:string|null;
  readonly launchInspectorSha256:string|null;
  readonly fullscreenProbeSha256:string|null;
}
declare const __PET_DESKTOP_NATIVE_ARTIFACT_PINS__:NativeArtifactPins;
const empty:NativeArtifactPins={whisperCliSha256:null,sapiHelperSha256:null,launchInspectorSha256:null,fullscreenProbeSha256:null};
export const nativeArtifactPins:NativeArtifactPins=Object.freeze(typeof __PET_DESKTOP_NATIVE_ARTIFACT_PINS__==='undefined'?empty:__PET_DESKTOP_NATIVE_ARTIFACT_PINS__);
