package memory_test

import (
	"testing"

	lic "github.com/AnoRebel/licensing/licensing"
	"github.com/AnoRebel/licensing/licensing/storage/conformance"
	"github.com/AnoRebel/licensing/licensing/storage/memory"
)

func TestConformance(t *testing.T) {
	conformance.RunAll(t, func(t *testing.T) lic.Storage {
		return memory.New(memory.Options{})
	})
}
