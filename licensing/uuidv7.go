package licensing

import (
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"time"
)

// NewUUIDv7 returns a fresh UUIDv7 string in the canonical
// 8-4-4-4-12 hex form. UUIDv7 is time-ordered (48-bit Unix-ms prefix) so
// lexical sort of the string matches insertion order within the same
// millisecond bucket — that property is what our pagination cursors rely
// on when they order by (created_at, id).
//
// NOT cryptographic material. Collision-resistance comes from the 74 bits
// of randomness filling bytes 6-15 (minus the version/variant nibbles).
// Callers that need unguessable tokens should use a crypto RNG directly.
func NewUUIDv7() string {
	var b [16]byte
	// 48 bits: Unix ms timestamp. Shift left 16 so the ms value lands in
	// b[0:6] big-endian, leaving b[6:8] for randomness + version nibble.
	nowMs := uint64(time.Now().UnixMilli())
	binary.BigEndian.PutUint64(b[:8], nowMs<<16)
	// Fill b[6:16] with crypto-random bytes. b[6:8] gets overwritten with
	// random, then we stamp the version nibble into b[6]'s high nibble.
	randPart := b[6:]
	if _, err := rand.Read(randPart); err != nil {
		// rand.Read only fails if the OS RNG is broken — there's nothing
		// useful the caller can do, so panic matches the stdlib idiom
		// around crypto/rand failures.
		panic("uuidv7: rand.Read failed: " + err.Error())
	}
	// Version 7: byte 6 high nibble = 0x7.
	b[6] = (b[6] & 0x0f) | 0x70
	// Variant RFC 4122: byte 8 high bits = 10xx xxxx.
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
