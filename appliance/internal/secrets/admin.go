package secrets

import (
	"fmt"
	"strings"
)

// specialUse is email-validator's SPECIAL_USE_DOMAIN_NAMES (2.3.0, the
// version in the payload lock). A domain equal to or under one of these is
// refused by core's EmailStr.
var specialUse = []string{"arpa", "invalid", "local", "localhost", "onion", "test"}

// CheckAdminEmail refuses an address core would refuse, so provisioning fails
// on the operator's screen instead of in core.log: a bootstrap admin core cannot
// accept leaves it crash-looping at startup with the console unreachable.
func CheckAdminEmail(email string) error {
	at := strings.LastIndex(email, "@")
	if at <= 0 || at == len(email)-1 {
		return fmt.Errorf("%q is not an email address", email)
	}
	domain := strings.ToLower(strings.TrimSuffix(email[at+1:], "."))
	if !strings.Contains(domain, ".") {
		return fmt.Errorf("%q: the domain needs a dot (e.g. admin@company.com)", email)
	}
	for _, s := range specialUse {
		if domain == s || strings.HasSuffix(domain, "."+s) {
			return fmt.Errorf("%q: .%s is a special-use domain the console refuses to sign in with", email, s)
		}
	}
	return nil
}
