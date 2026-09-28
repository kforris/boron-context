import Foundation

enum BoronClientError: LocalizedError {
    case invalidConfiguration
    case missingToken
    case invalidResponse
    case serverStatus(Int)

    var errorDescription: String? {
        switch self {
        case .invalidConfiguration:
            return "Boron menu configuration requires a loopback origin and an absolute token file path"
        case .missingToken:
            return "Boron daemon token is missing"
        case .invalidResponse:
            return "Boron returned an invalid response"
        case .serverStatus(let status):
            return "Boron returned HTTP \(status)"
        }
    }
}

struct BoronClient: Sendable {
    let baseURL: URL
    let tokenURL: URL
    let session: URLSession
    private let configurationIsValid: Bool

    init(
        baseURL: URL? = nil,
        tokenURL: URL? = nil,
        session: URLSession = .shared,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) {
        let origin = baseURL?.absoluteString ?? environment["BORON_DAEMON_URL"]
            ?? "http://127.0.0.1:41635"
        let configuredURL = URL(string: origin)
        let tokenPath = tokenURL?.path ?? environment["BORON_TOKEN_FILE"]
            ?? FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Library/Application Support/Boron Context/daemon.token").path
        self.baseURL = configuredURL ?? URL(string: "http://127.0.0.1:0")!
        self.tokenURL = URL(fileURLWithPath: tokenPath)
        self.configurationIsValid = Self.isLoopbackOrigin(origin)
            && tokenPath.hasPrefix("/") && !tokenPath.contains("\n") && !tokenPath.contains("\r")
            && (tokenURL?.isFileURL ?? true)
        self.session = session
    }

    static func isLoopbackOrigin(_ value: String) -> Bool {
        guard !value.contains("\n"), !value.contains("\r"),
            let url = URLComponents(string: value),
            ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
            ["127.0.0.1", "localhost", "::1", "[::1]"].contains(url.host?.lowercased() ?? ""),
            url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
            url.path.isEmpty || url.path == "/"
        else { return false }
        return url.url != nil
    }

    private func requireValidConfiguration() throws {
        guard configurationIsValid else { throw BoronClientError.invalidConfiguration }
    }

    func health() async throws -> BoronHealth {
        try requireValidConfiguration()
        let request = URLRequest(url: baseURL.appendingPathComponent("health"))
        let (data, response) = try await session.data(for: request)
        try validate(response)
        return try decoder().decode(BoronHealth.self, from: data)
    }

    func meter(project: String = "Boron Context", windowDays: Int = 30) async throws
        -> ContextMeterSummary
    {
        let token = try daemonToken()

        var request = URLRequest(url: baseURL.appendingPathComponent("v1/metrics/context"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(
            MeterRequest(projectHint: project, windowDays: windowDays, typingWordsPerMinute: 40)
        )

        let (data, response) = try await session.data(for: request)
        try validate(response)
        return try decoder().decode(ContextMeterSummary.self, from: data)
    }

    func audit(project: String = "Boron Context", windowDays: Int = 30, limit: Int = 5) async throws
        -> ContextMeterAudit
    {
        let token = try daemonToken()

        var request = URLRequest(
            url: baseURL.appendingPathComponent("v1/metrics/context/inspect")
        )
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(
            MeterAuditRequest(
                projectHint: project,
                windowDays: windowDays,
                typingWordsPerMinute: 40,
                limit: limit
            )
        )

        let (data, response) = try await session.data(for: request)
        try validate(response)
        return try decoder().decode(ContextMeterAudit.self, from: data)
    }

    func inspectorURL() async throws -> URL {
        let token = try daemonToken()
        var request = URLRequest(url: baseURL.appendingPathComponent("v1/inspector/ticket"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)

        let (data, response) = try await session.data(for: request)
        try validate(response)
        let ticket = try decoder().decode(InspectorTicket.self, from: data)
        guard let url = URL(string: ticket.url, relativeTo: baseURL)?.absoluteURL else {
            throw BoronClientError.invalidResponse
        }
        return url
    }

    private func validate(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else {
            throw BoronClientError.invalidResponse
        }
        guard 200 ..< 300 ~= http.statusCode else {
            throw BoronClientError.serverStatus(http.statusCode)
        }
    }

    private func daemonToken() throws -> String {
        try requireValidConfiguration()
        let token = try String(contentsOf: tokenURL, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else {
            throw BoronClientError.missingToken
        }
        return token
    }

    private func decoder() -> JSONDecoder {
        BoronJSONDecoder.make()
    }
}
