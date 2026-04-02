import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const mobileAppRoot = join(process.cwd(), "apps", "mobile");

if (!existsSync(join(mobileAppRoot, "package.json"))) {
  console.log("[patch-realtimekit-react-native] skipped: apps/mobile not present");
  process.exit(0);
}

const packageJsonPath = [join(mobileAppRoot, "node_modules", "@cloudflare", "realtimekit-react-native", "package.json"), join(process.cwd(), "node_modules", "@cloudflare", "realtimekit-react-native", "package.json")].find((candidate) => existsSync(candidate));

if (!packageJsonPath) {
  console.log("[patch-realtimekit-react-native] skipped: @cloudflare/realtimekit-react-native not installed");
  process.exit(0);
}
const packageRoot = dirname(packageJsonPath);
const stringsXmlPath = join(packageRoot, "android", "src", "main", "res", "values", "strings.xml");
const blobAuthorityName = "blob_provider_authority";
const blobAuthorityValue = "com.cloudflare.realtimekit.expo.blobs";
const nativeEventEmitterTargets = [
  join(packageRoot, "lib", "commonjs", "BackgroundHandler.js"),
  join(packageRoot, "lib", "module", "BackgroundHandler.js"),
  join(packageRoot, "lib", "commonjs", "LocalMediaHandler.js"),
  join(packageRoot, "lib", "module", "LocalMediaHandler.js"),
  join(packageRoot, "lib", "commonjs", "AudioSampleHandler.js"),
  join(packageRoot, "lib", "module", "AudioSampleHandler.js"),
  join(packageRoot, "lib", "commonjs", "LocalMediaUtils.js"),
  join(packageRoot, "lib", "module", "LocalMediaUtils.js"),
];
const webrtcNativeTargets = [join(mobileAppRoot, "node_modules", "@cloudflare", "react-native-webrtc", "ios", "RCTWebRTC", "WebRTCModule+Transceivers.m"), join(process.cwd(), "node_modules", "@cloudflare", "react-native-webrtc", "ios", "RCTWebRTC", "WebRTCModule+Transceivers.m")];
const webrtcMediaStreamNativeTargets = [join(mobileAppRoot, "node_modules", "@cloudflare", "react-native-webrtc", "ios", "RCTWebRTC", "WebRTCModule+RTCMediaStream.m"), join(process.cwd(), "node_modules", "@cloudflare", "react-native-webrtc", "ios", "RCTWebRTC", "WebRTCModule+RTCMediaStream.m")];

const nativeEventEmitterHelperDeclaration = `const ensureNativeEventEmitterContract = module => module && typeof module.addListener === "function" && typeof module.removeListeners === "function" ? module : module ? {\n  ...module,\n  addListener() {},\n  removeListeners() {},\n} : null;\n`;

const nativeEventEmitterReplacements: Array<[string, string]> = [
  ["const Emitter = new NativeEventEmitter(RTKRNBackgroundTimer);", `${nativeEventEmitterHelperDeclaration}const Emitter = new NativeEventEmitter(ensureNativeEventEmitterContract(RTKRNBackgroundTimer));`],
  ["const Emitter = new _reactNative.NativeEventEmitter(RTKRNBackgroundTimer);", `${nativeEventEmitterHelperDeclaration}const Emitter = new _reactNative.NativeEventEmitter(ensureNativeEventEmitterContract(RTKRNBackgroundTimer));`],
  ["const broadcastEmitter = new NativeEventEmitter(BroadcastEventEmitter);", `${nativeEventEmitterHelperDeclaration}const broadcastEmitter = new NativeEventEmitter(ensureNativeEventEmitterContract(BroadcastEventEmitter));`],
  ["const broadcastEmitter = new _reactNative.NativeEventEmitter(BroadcastEventEmitter);", `${nativeEventEmitterHelperDeclaration}const broadcastEmitter = new _reactNative.NativeEventEmitter(ensureNativeEventEmitterContract(BroadcastEventEmitter));`],
  ["this.webRTCModuleEmitter = new NativeEventEmitter(WebRTCModule);", `${nativeEventEmitterHelperDeclaration}    this.webRTCModuleEmitter = new NativeEventEmitter(ensureNativeEventEmitterContract(WebRTCModule));`],
  ["this.webRTCModuleEmitter = new _reactNative.NativeEventEmitter(WebRTCModule);", `${nativeEventEmitterHelperDeclaration}    this.webRTCModuleEmitter = new _reactNative.NativeEventEmitter(ensureNativeEventEmitterContract(WebRTCModule));`],
  ["_classPrivateFieldSet(_nativeEventEmitter, this, new NativeEventEmitter(NativeModules.InCallManager));", `${nativeEventEmitterHelperDeclaration}    _classPrivateFieldSet(_nativeEventEmitter, this, new NativeEventEmitter(ensureNativeEventEmitterContract(NativeModules.InCallManager)));`],
  [
    "_classPrivateFieldSet(_nativeEventEmitter, this, new _reactNative.NativeEventEmitter(_reactNative.NativeModules.InCallManager));",
    `${nativeEventEmitterHelperDeclaration}    _classPrivateFieldSet(_nativeEventEmitter, this, new _reactNative.NativeEventEmitter(ensureNativeEventEmitterContract(_reactNative.NativeModules.InCallManager)));`,
  ],
];

const simulatorCapabilitiesHelpers = {
  commonjs: `const EMPTY_SIMULATOR_CAPABILITIES = Object.freeze({\n  codecs: [],\n  headerExtensions: [],\n});\nfunction cloneSimulatorCapabilities() {\n  return {\n    codecs: [...EMPTY_SIMULATOR_CAPABILITIES.codecs],\n    headerExtensions: [...EMPTY_SIMULATOR_CAPABILITIES.headerExtensions],\n  };\n}\nfunction shouldBypassNativeCapabilities() {\n  return _reactNative.Platform.OS === "ios" && _reactNative.NativeModules?.ChalkRuntimeInfo?.isSimulator === true;\n}\n`,
  module: `const EMPTY_SIMULATOR_CAPABILITIES = Object.freeze({\n  codecs: [],\n  headerExtensions: [],\n});\nfunction cloneSimulatorCapabilities() {\n  return {\n    codecs: [...EMPTY_SIMULATOR_CAPABILITIES.codecs],\n    headerExtensions: [...EMPTY_SIMULATOR_CAPABILITIES.headerExtensions],\n  };\n}\nfunction shouldBypassNativeCapabilities() {\n  return Platform.OS === 'ios' && NativeModules?.ChalkRuntimeInfo?.isSimulator === true;\n}\n`,
};
const nativeSimulatorCapabilitiesHelper = `NSDictionary *chalkEmptySimulatorCapabilitiesJSON(void) {
    return @{
        @"codecs": @[],
        @"headerExtensions": @[],
    };
}

`;
const senderCapabilitiesMethod = `RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(senderGetCapabilities : (NSString *)kind) {
#if TARGET_OS_SIMULATOR
    return chalkEmptySimulatorCapabilitiesJSON();
#else
    __block id params;

    dispatch_sync(self.workerQueue, ^{
        RTKRTCRtpMediaType mediaType = RTKRTCRtpMediaTypeUnsupported;
        if ([kind isEqual:@"audio"]) {
            mediaType = RTKRTCRtpMediaTypeAudio;
        } else if ([kind isEqual:@"video"]) {
            mediaType = RTKRTCRtpMediaTypeVideo;
        }

        RTKRTCRtpCapabilities *capabilities = [self.peerConnectionFactory rtpSenderCapabilitiesForKind:mediaTypeToString(mediaType)];
        params = [SerializeUtils capabilitiesToJSON:capabilities];
    });

    return params;
#endif
}
`;
const receiverCapabilitiesMethod = `RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(receiverGetCapabilities : (NSString *)kind) {
#if TARGET_OS_SIMULATOR
    return chalkEmptySimulatorCapabilitiesJSON();
#else
    __block id params;

    dispatch_sync(self.workerQueue, ^{
        RTKRTCRtpMediaType mediaType = RTKRTCRtpMediaTypeUnsupported;
        if ([kind isEqual:@"audio"]) {
            mediaType = RTKRTCRtpMediaTypeAudio;
        } else if ([kind isEqual:@"video"]) {
            mediaType = RTKRTCRtpMediaTypeVideo;
        }

        RTKRTCRtpCapabilities *capabilities = [self.peerConnectionFactory rtpReceiverCapabilitiesForKind:mediaTypeToString(mediaType)];
        params = [SerializeUtils capabilitiesToJSON:capabilities];
    });

    return params;
#endif
}
`;
const transceiverCodecPreferencesMethod = `RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(transceiverSetCodecPreferences
                                       : (nonnull NSNumber *)objectID senderId
                                       : (NSString *)senderId codecPreferences
                                       : (NSArray *)codecPreferences) {
#if TARGET_OS_SIMULATOR
    return nil;
#else
    RTKRTCPeerConnection *peerConnection = self.peerConnections[objectID];

    if (peerConnection == nil) {
        RCTLogWarn(@"PeerConnection %@ not found in transceiverSetCodecPreferences()", objectID);
        return nil;
    }

    RTKRTCRtpTransceiver *transceiver = nil;
    for (RTKRTCRtpTransceiver *t in peerConnection.transceivers) {
        if ([senderId isEqual:t.sender.senderId]) {
            transceiver = t;
            break;
        }
    }

    if (transceiver == nil) {
        RCTLogWarn(@"transceiverSetCodecPreferences() transceiver is null");
        return nil;
    }

    // Get the available codecs
    RTKRTCRtpTransceiverDirection direction = transceiver.direction;
    NSMutableArray *availableCodecs = [NSMutableArray new];
    if (direction == RTKRTCRtpTransceiverDirectionSendRecv || direction == RTKRTCRtpTransceiverDirectionSendOnly) {
        RTKRTCRtpCapabilities *capabilities = [self.peerConnectionFactory rtpSenderCapabilitiesForKind:mediaTypeToString(transceiver.mediaType)];
        for (RTKRTCRtpCodecCapability *codec in capabilities.codecs) {
            NSDictionary *codecDict = [SerializeUtils codecCapabilityToJSON:codec];
            [availableCodecs addObject:@{
                @"dict" : codecDict,
                @"codec" : codec,
            }];
        }
    }
    if (direction == RTKRTCRtpTransceiverDirectionSendRecv || direction == RTKRTCRtpTransceiverDirectionRecvOnly) {
        RTKRTCRtpCapabilities *capabilities =
            [self.peerConnectionFactory rtpReceiverCapabilitiesForKind:mediaTypeToString(transceiver.mediaType)];
        for (RTKRTCRtpCodecCapability *codec in capabilities.codecs) {
            NSDictionary *codecDict = [SerializeUtils codecCapabilityToJSON:codec];
            [availableCodecs addObject:@{
                @"dict" : codecDict,
                @"codec" : codec,
            }];
        }
    }
    
    // Convert JSON codec capabilities to the actual objects.
    // Codec preferences is order sensitive.
    NSMutableArray *codecsToSet = [NSMutableArray new];

    for (NSDictionary *codecDict in codecPreferences) {
        for (NSDictionary *entry in availableCodecs) {
            NSDictionary *availableCodecDict = [entry objectForKey:@"dict"];
            if ([codecDict isEqualToDictionary:availableCodecDict]) {
                [codecsToSet addObject:[entry objectForKey:@"codec"]];
                break;
            }
        }
    }

    NSError *error;
    transceiver.codecPreferences = codecsToSet;
    // [transceiver setCodecPreferences:codecsToSet error:&error];

    if (error) {
        RTCLogError(@"transceiverSetCodecPreferences() Could not set preferences: %@", error);
    }
    return nil;
#endif
}
`;
const simulatorEnumerateDevicesMethod = `RCT_EXPORT_METHOD(enumerateDevices : (RCTResponseSenderBlock)callback) {
#if TARGET_OS_SIMULATOR
    callback(@[ @[] ]);
#elif TARGET_OS_TV
    callback(@[]);
#else
    NSMutableArray *devices = [NSMutableArray array];
    AVCaptureDeviceDiscoverySession *videoevicesSession =
        [AVCaptureDeviceDiscoverySession discoverySessionWithDeviceTypes:@[ AVCaptureDeviceTypeBuiltInWideAngleCamera ]
                                                               mediaType:AVMediaTypeVideo
                                                                position:AVCaptureDevicePositionUnspecified];
    for (AVCaptureDevice *device in videoevicesSession.devices) {
        NSString *position = @"unknown";
        if (device.position == AVCaptureDevicePositionBack) {
            position = @"environment";
        } else if (device.position == AVCaptureDevicePositionFront) {
            position = @"front";
        }
        NSString *label = @"Unknown video device";
        if (device.localizedName != nil) {
            label = device.localizedName;
        }
        [devices addObject:@{
            @"facing" : position,
            @"deviceId" : device.uniqueID,
            @"groupId" : @"",
            @"label" : label,
            @"kind" : @"videoinput",
        }];
    }
    AVCaptureDeviceDiscoverySession *audioDevicesSession =
        [AVCaptureDeviceDiscoverySession discoverySessionWithDeviceTypes:@[ AVCaptureDeviceTypeBuiltInMicrophone ]
                                                               mediaType:AVMediaTypeAudio
                                                                position:AVCaptureDevicePositionUnspecified];
    for (AVCaptureDevice *device in audioDevicesSession.devices) {
        NSString *label = @"Unknown audio device";
        if (device.localizedName != nil) {
            label = device.localizedName;
        }
        [devices addObject:@{
            @"deviceId" : device.uniqueID,
            @"groupId" : @"",
            @"label" : label,
            @"kind" : @"audioinput",
        }];
    }
    callback(@[ devices ]);
#endif
}
`;

const nextContents = `<resources>
  <string name="${blobAuthorityName}">${blobAuthorityValue}</string>
</resources>
`;

mkdirSync(dirname(stringsXmlPath), { recursive: true });

let currentContents = "";

try {
  currentContents = readFileSync(stringsXmlPath, "utf8");
} catch {
  currentContents = "";
}

if (currentContents.includes(`name="${blobAuthorityName}"`)) {
} else {
  writeFileSync(stringsXmlPath, nextContents, "utf8");
  console.log(`[patch-realtimekit-react-native] wrote ${stringsXmlPath}`);
}

// Patch @cloudflare/react-native-webrtc EventEmitter (removed RN internal)
const webrtcPackageRoot = [join(mobileAppRoot, "node_modules", "@cloudflare", "react-native-webrtc"), join(process.cwd(), "node_modules", "@cloudflare", "react-native-webrtc")].find((candidate) => existsSync(join(candidate, "package.json")));

if (webrtcPackageRoot) {
  const webrtcEventEmitterTargets = [join(webrtcPackageRoot, "lib", "commonjs", "EventEmitter.js"), join(webrtcPackageRoot, "lib", "module", "EventEmitter.js")];
  const simulatorCapabilitiesTargets = [join(webrtcPackageRoot, "lib", "commonjs", "RTCRtpReceiver.js"), join(webrtcPackageRoot, "lib", "module", "RTCRtpReceiver.js"), join(webrtcPackageRoot, "lib", "commonjs", "RTCRtpSender.js"), join(webrtcPackageRoot, "lib", "module", "RTCRtpSender.js")];

  // Minimal EventEmitter polyfill to replace the removed RN internal
  const polyfill = `class _Emitter{constructor(){this._listeners={}}addListener(e,h){(this._listeners[e]||(this._listeners[e]=[])).push(h);return{remove:()=>{const a=this._listeners[e];if(a){const i=a.indexOf(h);if(i!==-1)a.splice(i,1)}}}}emit(e,...a){(this._listeners[e]||[]).forEach(h=>h(...a))}removeAllListeners(e){if(e)delete this._listeners[e];else this._listeners={}}}`;

  for (const targetPath of webrtcEventEmitterTargets) {
    if (!existsSync(targetPath)) {
      continue;
    }

    let contents = readFileSync(targetPath, "utf8");

    if (contents.includes("_Emitter")) {
      continue; // already patched
    }

    // commonjs variant
    contents = contents.replace(/var _EventEmitter = _interopRequireDefault\(require\("react-native\/Libraries\/vendor\/emitter\/EventEmitter"\)\);/, polyfill);
    contents = contents.replace(/new _EventEmitter\.default\(\)/g, "new _Emitter()");

    // module variant
    contents = contents.replace(/import EventEmitter from 'react-native\/Libraries\/vendor\/emitter\/EventEmitter';/, polyfill);
    contents = contents.replace(/new EventEmitter\(\)/g, "new _Emitter()");

    writeFileSync(targetPath, contents, "utf8");
    console.log(`[patch-realtimekit-react-native] patched webrtc EventEmitter: ${targetPath}`);
  }

  for (const targetPath of simulatorCapabilitiesTargets) {
    if (!existsSync(targetPath)) {
      continue;
    }

    let contents = readFileSync(targetPath, "utf8");

    if (contents.includes("EMPTY_SIMULATOR_CAPABILITIES")) {
      continue;
    }

    if (targetPath.endsWith("lib/commonjs/RTCRtpReceiver.js")) {
      contents = contents.replace(`const {\n  WebRTCModule\n} = _reactNative.NativeModules;\n`, `const {\n  WebRTCModule\n} = _reactNative.NativeModules;\n${simulatorCapabilitiesHelpers.commonjs}`);
      contents = contents.replace(
        `  static getCapabilities(kind) {\n    return WebRTCModule.receiverGetCapabilities(kind);\n  }\n`,
        `  static getCapabilities(kind) {\n    if (shouldBypassNativeCapabilities()) {\n      return cloneSimulatorCapabilities();\n    }\n    return WebRTCModule.receiverGetCapabilities(kind);\n  }\n`,
      );
    } else if (targetPath.endsWith("lib/module/RTCRtpReceiver.js")) {
      contents = contents.replace(`const {\n  WebRTCModule\n} = NativeModules;\n`, `const {\n  WebRTCModule\n} = NativeModules;\n${simulatorCapabilitiesHelpers.module}`);
      contents = contents.replace(
        `  static getCapabilities(kind) {\n    return WebRTCModule.receiverGetCapabilities(kind);\n  }\n`,
        `  static getCapabilities(kind) {\n    if (shouldBypassNativeCapabilities()) {\n      return cloneSimulatorCapabilities();\n    }\n    return WebRTCModule.receiverGetCapabilities(kind);\n  }\n`,
      );
    } else if (targetPath.endsWith("lib/commonjs/RTCRtpSender.js")) {
      contents = contents.replace(`const {\n  WebRTCModule\n} = _reactNative.NativeModules;\n`, `const {\n  WebRTCModule\n} = _reactNative.NativeModules;\n${simulatorCapabilitiesHelpers.commonjs}`);
      contents = contents.replace(
        `  static getCapabilities(kind) {\n    return WebRTCModule.senderGetCapabilities(kind);\n  }\n`,
        `  static getCapabilities(kind) {\n    if (shouldBypassNativeCapabilities()) {\n      return cloneSimulatorCapabilities();\n    }\n    return WebRTCModule.senderGetCapabilities(kind);\n  }\n`,
      );
    } else if (targetPath.endsWith("lib/module/RTCRtpSender.js")) {
      contents = contents.replace(`const {\n  WebRTCModule\n} = NativeModules;\n`, `const {\n  WebRTCModule\n} = NativeModules;\n${simulatorCapabilitiesHelpers.module}`);
      contents = contents.replace(
        `  static getCapabilities(kind) {\n    return WebRTCModule.senderGetCapabilities(kind);\n  }\n`,
        `  static getCapabilities(kind) {\n    if (shouldBypassNativeCapabilities()) {\n      return cloneSimulatorCapabilities();\n    }\n    return WebRTCModule.senderGetCapabilities(kind);\n  }\n`,
      );
    }

    writeFileSync(targetPath, contents, "utf8");
    console.log(`[patch-realtimekit-react-native] patched simulator capabilities: ${targetPath}`);
  }
}

for (const targetPath of webrtcNativeTargets) {
  if (!existsSync(targetPath)) {
    continue;
  }

  let contents = readFileSync(targetPath, "utf8");
  let didPatch = false;

  if (!contents.includes("#import <TargetConditionals.h>")) {
    contents = contents.replace("#import <objc/runtime.h>\n", "#import <objc/runtime.h>\n#import <TargetConditionals.h>\n");
    didPatch = true;
  }

  if (!contents.includes("chalkEmptySimulatorCapabilitiesJSON")) {
    contents = contents.replace("}\n\nRCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(senderGetCapabilities", `}\n\n${nativeSimulatorCapabilitiesHelper}RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(senderGetCapabilities`);
    didPatch = true;
  }

  const nextContents = contents
    .replace(/RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD\(senderGetCapabilities : \(NSString \*\)kind\) \{[\s\S]*?^}\n/m, `${senderCapabilitiesMethod}\n`)
    .replace(/RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD\(receiverGetCapabilities : \(NSString \*\)kind\) \{[\s\S]*?^}\n/m, `${receiverCapabilitiesMethod}\n`)
    .replace(/RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD\(transceiverSetCodecPreferences[\s\S]*?^}\n/m, `${transceiverCodecPreferencesMethod}\n`);

  if (nextContents !== contents) {
    contents = nextContents;
    didPatch = true;
  }

  if (!didPatch) {
    continue;
  }

  writeFileSync(targetPath, contents, "utf8");
  console.log(`[patch-realtimekit-react-native] patched iOS simulator capabilities: ${targetPath}`);
}

for (const targetPath of webrtcMediaStreamNativeTargets) {
  if (!existsSync(targetPath)) {
    continue;
  }

  let contents = readFileSync(targetPath, "utf8");
  let didPatch = false;

  if (!contents.includes("#import <TargetConditionals.h>")) {
    contents = contents.replace("#import <objc/runtime.h>\n", "#import <objc/runtime.h>\n#import <TargetConditionals.h>\n");
    didPatch = true;
  }

  const safeVideoSettingsContents = contents.replace(
    `        if ([track.kind isEqualToString:@"video"]) {\n            RTKRTCVideoTrack *videoTrack = (RTKRTCVideoTrack *)track;\n            VideoCaptureController *vcc = (VideoCaptureController *)videoTrack.captureController;\n            AVCaptureDeviceFormat *format = vcc.selectedFormat;\n            CMVideoDimensions dimensions = CMVideoFormatDescriptionGetDimensions(format.formatDescription);\n            settings = @{@"height" : @(dimensions.height), @"width" : @(dimensions.width), @"frameRate" : @(30)};\n        }\n`,
    `        if ([track.kind isEqualToString:@"video"] && [((RTKRTCVideoTrack *)track).captureController isKindOfClass:[VideoCaptureController class]]) {\n            RTKRTCVideoTrack *videoTrack = (RTKRTCVideoTrack *)track;\n            VideoCaptureController *vcc = (VideoCaptureController *)videoTrack.captureController;\n            AVCaptureDeviceFormat *format = vcc.selectedFormat;\n            CMVideoDimensions dimensions = CMVideoFormatDescriptionGetDimensions(format.formatDescription);\n            settings = @{@"height" : @(dimensions.height), @"width" : @(dimensions.width), @"frameRate" : @(30)};\n        }\n`,
  );

  if (safeVideoSettingsContents !== contents) {
    contents = safeVideoSettingsContents;
    didPatch = true;
  }

  const nextContents = contents.replace(/RCT_EXPORT_METHOD\(enumerateDevices : \(RCTResponseSenderBlock\)callback\) \{[\s\S]*?^}\n/m, `${simulatorEnumerateDevicesMethod}\n`);

  if (nextContents !== contents) {
    contents = nextContents;
    didPatch = true;
  }

  if (!didPatch) {
    continue;
  }

  writeFileSync(targetPath, contents, "utf8");
  console.log(`[patch-realtimekit-react-native] patched iOS simulator media stream safety: ${targetPath}`);
}

for (const targetPath of nativeEventEmitterTargets) {
  if (!existsSync(targetPath)) {
    continue;
  }

  let targetContents = readFileSync(targetPath, "utf8");
  let didPatch = false;

  for (const [searchValue, replaceValue] of nativeEventEmitterReplacements) {
    if (!targetContents.includes(searchValue)) {
      continue;
    }

    targetContents = targetContents.replace(searchValue, replaceValue);
    didPatch = true;
  }

  if (!didPatch) {
    continue;
  }

  writeFileSync(targetPath, targetContents, "utf8");
  console.log(`[patch-realtimekit-react-native] patched ${targetPath}`);
}
