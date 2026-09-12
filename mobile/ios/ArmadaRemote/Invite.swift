import Foundation

enum RelayKind: String {
    case pair
    case op
}

struct RelayInvite: Equatable {
    var kind: RelayKind
    var relay: String
    var fleet: String
    var tokenOrSecret: String
}

enum RelayUriError: String, Error {
    case invalid
    case incomplete
    case insecure
}

enum RelayInviteParser {
    private static let fleetRe = try! NSRegularExpression(pattern: "^[a-z0-9-]{8,64}$")
    private static let hex64Re = try! NSRegularExpression(pattern: "^[a-f0-9]{64}$")

    static func origin(of relay: String) -> String? {
        guard let u = URL(string: relay), let scheme = u.scheme, let host = u.host else { return nil }
        let loopback = host == "127.0.0.1" || host == "localhost"
        let hostPort = u.port.map { "\(host):\($0)" } ?? host
        if scheme == "https" { return "\(scheme)://\(hostPort)" }
        if scheme == "http" && loopback { return "\(scheme)://\(hostPort)" }
        return nil
    }

    static func parse(_ input: String) -> Result<RelayInvite, RelayUriError> {
        guard let url = URL(string: input.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            return .failure(.invalid)
        }
        guard url.scheme == "armada-relay" else { return .failure(.invalid) }
        let kindRaw = (url.host ?? "") + url.path
        let kind: RelayKind?
        switch kindRaw.replacingOccurrences(of: "/", with: "") {
        case "pair": kind = .pair
        case "op": kind = .op
        default: kind = nil
        }
        guard let kind else { return .failure(.invalid) }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func q(_ name: String) -> String {
            items.first(where: { $0.name == name })?.value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        }
        let relayRaw = q("relay")
        let fleet = q("fleet")
        if relayRaw.isEmpty || fleet.isEmpty { return .failure(.incomplete) }
        guard let origin = origin(of: relayRaw) else { return .failure(.insecure) }
        if !matches(fleetRe, fleet) { return .failure(.incomplete) }
        let cred = kind == .pair ? q("secret") : q("token")
        if !matches(hex64Re, cred) { return .failure(.incomplete) }
        return .success(RelayInvite(kind: kind, relay: origin, fleet: fleet, tokenOrSecret: cred))
    }

    private static func matches(_ re: NSRegularExpression, _ s: String) -> Bool {
        re.firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) != nil
    }
}
