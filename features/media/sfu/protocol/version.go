package protocol

// WireProtocol is the request-body revision this build of the node decodes. The node decodes
// requests strictly, so a field it does not know is refused with 400 invalid_request. A caller
// that sends a newer field reads ReadyResponse.Protocol first and places nothing on a node below
// the revision the field needs. A node that predates the field reports none, which reads as 0.
//
//	1: the original bodies.
//	2: create, reserve, move and source-control bodies carry allocationGeneration. A body without
//	   it is still accepted, so an API that predates the field still places on a node of this revision.
//	3: the node accepts a receive-only offer, so a listener with nothing to publish can join. A node
//	   below this answers one with 400 invalid_request.
//
// Raise it when a caller may send a field or a request shape an older node refuses, and in the same
// change raise the caller's minimum.
const WireProtocol = 3
