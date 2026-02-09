import Foundation

struct ChalkEnv {
    let apiUrl: URL
    let wsUrl: URL
    let apiKey: String
    let roomPrefix: String

    static func load() throws -> ChalkEnv {
        guard let url = Bundle.main.url(forResource: "chalk", withExtension: "env") else {
            throw NSError(domain: "ChalkEnv", code: 1, userInfo: [NSLocalizedDescriptionKey: "Missing chalk.env in app bundle"])
        }
        let text = try String(contentsOf: url, encoding: .utf8)
        let map = parse(text: text)

        let apiUrlStr = (map["CHALK_API_URL"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let wsUrlStr = (map["CHALK_WS_URL"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let apiKey = (map["CHALK_API_KEY"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let roomPrefix = (map["CHALK_ROOM_PREFIX"] ?? "native").trimmingCharacters(in: .whitespacesAndNewlines)

        guard let apiUrl = URL(string: apiUrlStr), !apiUrlStr.isEmpty else {
            throw NSError(domain: "ChalkEnv", code: 2, userInfo: [NSLocalizedDescriptionKey: "Missing CHALK_API_URL in chalk.env"])
        }
        guard let wsUrl = URL(string: wsUrlStr), !wsUrlStr.isEmpty else {
            throw NSError(domain: "ChalkEnv", code: 3, userInfo: [NSLocalizedDescriptionKey: "Missing CHALK_WS_URL in chalk.env"])
        }
        guard !apiKey.isEmpty else {
            throw NSError(domain: "ChalkEnv", code: 4, userInfo: [NSLocalizedDescriptionKey: "Missing CHALK_API_KEY in chalk.env"])
        }

        return ChalkEnv(apiUrl: apiUrl, wsUrl: wsUrl, apiKey: apiKey, roomPrefix: roomPrefix.isEmpty ? "native" : roomPrefix)
    }

    private static func parse(text: String) -> [String: String] {
        var out: [String: String] = [:]
        for rawLine in text.split(whereSeparator: \.isNewline) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.isEmpty { continue }
            if line.hasPrefix("#") { continue }
            guard let idx = line.firstIndex(of: "=") else { continue }
            let key = String(line[..<idx]).trimmingCharacters(in: .whitespaces)
            let val = String(line[line.index(after: idx)...]).trimmingCharacters(in: .whitespaces)
            if !key.isEmpty { out[key] = val }
        }
        return out
    }
}

