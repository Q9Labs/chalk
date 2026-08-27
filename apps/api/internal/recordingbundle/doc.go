// Package recordingbundle owns the immutable, provider-neutral recording
// bundle written by the capture worker.
//
// The package deliberately does not import Pion or an object-storage client.
// RTP adapters copy the small RTPPacket shape into an Assembler, and the
// sealed bytes can then be encrypted and uploaded by an outer worker.
package recordingbundle
