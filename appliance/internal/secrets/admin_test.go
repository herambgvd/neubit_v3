package secrets

import "testing"

func TestAdminEmailCoreWouldRefuseIsRefusedHere(t *testing.T) {
	for _, bad := range []string{"admin@neubit.local", "admin@neubit.test", "a@localhost",
		"a@x.ONION", "admin", "@x.com", "admin@", "admin@intranet"} {
		if CheckAdminEmail(bad) == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestOrdinaryAdminEmailIsAccepted(t *testing.T) {
	for _, ok := range []string{"ops@company.com", "admin@site.co.in", "admin@neubit.lan"} {
		if err := CheckAdminEmail(ok); err != nil {
			t.Errorf("%q refused: %v", ok, err)
		}
	}
}
