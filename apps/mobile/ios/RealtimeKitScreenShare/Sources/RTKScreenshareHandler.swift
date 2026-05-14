import ReplayKit

open class RTKScreenshareHandler: RPBroadcastSampleHandler {
    private var clientConnection: RTKSocketConnection?
    private var uploader: RTKScreenshareUploader?
    private var frameCount: Int = 0

    private let appGroupIdentifier: String
    private let bundleIdentifier: String

    public override init() {
        appGroupIdentifier = ""
        bundleIdentifier = ""
        super.init()
    }

    public init(appGroupIdentifier: String, bundleIdentifier: String) {
        self.appGroupIdentifier = appGroupIdentifier
        self.bundleIdentifier = bundleIdentifier
        super.init()
        if let connection = RTKSocketConnection(filePath: socketFilePath) {
            clientConnection = connection
            setupConnection()
            uploader = RTKScreenshareUploader(connection: connection, bundleIdentifier: bundleIdentifier)
        }
    }

    private var socketFilePath: String {
        let sharedContainer = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier)
        return sharedContainer?.appendingPathComponent("rtc_SSFD").path ?? ""
    }

    public override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        frameCount = 0
        RTKDarwinNotificationCenter.shared.postNotification(.broadcastStarted)
        openConnection()
    }

    public override func broadcastPaused() {
    }

    public override func broadcastResumed() {
    }

    public override func broadcastFinished() {
        RTKDarwinNotificationCenter.shared.postNotification(.broadcastStopped)
        clientConnection?.close()
    }

    override public func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        switch sampleBufferType {
        case .video:
            frameCount += 1
            uploader?.send(sample: sampleBuffer)
            if frameCount % 3 == 0 {
                uploader?.send(sample: sampleBuffer)
            }
        default:
            break
        }
    }
}

private extension RTKScreenshareHandler {
    func setupConnection() {
        clientConnection?.didClose = { [weak self] error in
            print("[RTK][DEBUG] client connection did close \(String(describing: error))")

            if let error {
                self?.finishBroadcastWithError(error)
            } else {
                let screenSharingStopped = 10001
                let customError = NSError(
                    domain: RPRecordingErrorDomain,
                    code: screenSharingStopped,
                    userInfo: [NSLocalizedDescriptionKey: "Screen sharing stopped"]
                )
                self?.finishBroadcastWithError(customError)
            }
        }
    }

    func openConnection() {
        let queue = DispatchQueue(label: "broadcast.connectTimer")
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: .milliseconds(100), leeway: .milliseconds(500))
        timer.setEventHandler { [weak self] in
            guard self?.clientConnection?.open() == true else {
                return
            }

            timer.cancel()
        }

        timer.resume()
    }
}
