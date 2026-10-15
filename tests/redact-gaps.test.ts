import { describe, it, expect } from "vitest";
import { redact } from "../lib/redact";

// Fixtures are assembled at runtime, same convention as tests/redact.test.ts, so no
// credential-shaped literal ever sits in the repository (a push-time secret scanner rejects
// commits containing them).
const ATLASSIAN_TOKEN = ["ATATT", "3xFfGF0", "abcdefghijklmnopqrstuvwxyz0123456789"].join("");
const SLACK_BOT_TOKEN = ["xoxb-", "111111111111", "-222222222222222-", "abcdefghijklmnopqrstuvwx"].join("");
const SLACK_USER_TOKEN = ["xoxp-", "333333333333", "-444444444444444-", "zyxwvutsrqponmlkjihgfedc"].join("");

describe("redact: Atlassian API tokens", () => {
  it("masks a standalone ATATT-style token", () => {
    expect(redact(ATLASSIAN_TOKEN)).toBe("[redacted]");
  });

  it("masks an ATATT-style token embedded in a sentence", () => {
    // The generic "token: <value>" pattern matches first and consumes the
    // label along with the value, same as the existing password= behaviour.
    expect(redact(`Confluence token: ${ATLASSIAN_TOKEN} — keep it secret`)).toBe(
      "Confluence [redacted] — keep it secret",
    );
  });
});

describe("redact: Slack-style tokens", () => {
  it("masks a bot token (xoxb-...)", () => {
    expect(redact(SLACK_BOT_TOKEN)).toBe("[redacted]");
  });

  it("masks a user token (xoxp-...) embedded in text", () => {
    // Same label-consuming behaviour as the "token = " key/value pattern above.
    expect(redact(`Slack token = ${SLACK_USER_TOKEN} for the bot`)).toBe(
      "Slack [redacted] for the bot",
    );
  });

  it("masks a Slack token pasted into a learning body without a labelling keyword", () => {
    const body = `Use this to auth: ${SLACK_BOT_TOKEN} when calling the webhook.`;
    const result = redact(body);
    expect(result).not.toContain(SLACK_BOT_TOKEN);
    expect(result).toContain("[redacted]");
  });
});

describe("redact: review 2026-09-30 gaps", () => {
  it("masks the value of an underscore-prefixed key name", () => {
    const out = redact("ENH_NUGET_PASSWORD=hunter2hunter2");
    expect(out).not.toContain("hunter2");
  });

  it("masks a quoted key followed by a colon", () => {
    expect(redact('{"password": "hunter2hunter2"}')).not.toContain("hunter2");
    expect(redact('{"clientSecret": "abcdefabcdef12"}')).not.toContain("abcdefabcdef12");
  });

  it("masks SharedAccessKey and AccountKey values", () => {
    const sak = ["SharedAccessKey=", "AbCdEf123456789012345678901234567890abcd", "="].join("");
    expect(redact(sak)).not.toContain("AbCdEf12345");
    const ak = ["AccountKey=", "AbCdEf1234567890+/abcdef12345678901234567890", "=="].join("");
    expect(redact(ak)).not.toContain("AbCdEf12345");
  });

  it("masks Azure DevOps PAT shapes", () => {
    const pat = "abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst";
    expect(pat).toHaveLength(52);
    expect(redact(`use pat ${pat} for the feed`)).not.toContain(pat);
    expect(redact(`pat=${pat}`)).not.toContain(pat);
    const basic = Buffer.from(`:${pat}`).toString("base64");
    expect(redact(`Authorization: Basic ${basic}`)).not.toContain(basic);
  });

  it("masks HashiCorp Vault tokens", () => {
    const legacy = ["s.", "AbCdEf1hIjKlMnOpQrStUvWx"].join("");
    expect(redact(`vault token ${legacy} was used`)).not.toContain(legacy);
    const hvs = ["hvs.", "CAESIAbCdEfGhIjKlMnOpQrStUv"].join("");
    expect(redact(`login gave ${hvs}`)).not.toContain(hvs);
  });

  it("leaves ordinary words alone", () => {
    const prose = "Rotate the password and the secret regularly; a token is short-lived. See s.o. and v1.2.3.";
    expect(redact(prose)).toBe(prose);
    expect(redact("the password field is empty")).toBe("the password field is empty");
  });
});

describe("redact: final review", () => {
  it("does not go quadratic on runs of underscores", () => {
    for (const input of ["_".repeat(100000), "a_".repeat(50000)]) {
      const t0 = performance.now();
      redact(input);
      expect(performance.now() - t0).toBeLessThan(50);
    }
  });

  it("still masks prefixed, camel-case, quoted and snake-case keys", () => {
    expect(redact("ENH_NUGET_PASSWORD=hunter2hunter2")).not.toContain("hunter2");
    expect(redact("clientSecret: abcdefabcdef12")).not.toContain("abcdefabcdef12");
    expect(redact('{"password": "h"}')).not.toContain('"h"');
    expect(redact("my_token=abc")).not.toContain("abc");
  });

  it("leaves flags, nulls and plain numbers alone", () => {
    for (const s of [
      "requirePassword: true",
      "isSecret=false",
      "resetToken = null",
      "max_token: 4000",
      "secret: undefined",
    ]) {
      expect(redact(s)).toBe(s);
    }
  });
});

describe("redact: BAB personal tokens", () => {
  // Assembled at runtime like the fixtures above; 43 base64url characters after the prefix.
  const BAB_TOKEN = ["bab", "_", "Zk3Qm9xT2vLw7RnB0cYdHf5sJgA8uEoP1iNtXzV4yKe"].join("");

  it("has the fixture shape the issuer produces", () => {
    expect(BAB_TOKEN).toMatch(/^bab_[A-Za-z0-9_-]{43}$/);
  });

  it("masks a token pasted on its own", () => {
    expect(redact(BAB_TOKEN)).toBe("[redacted]");
  });

  it("masks a token inside a learning or message body", () => {
    const out = redact(`I set it to ${BAB_TOKEN} and it worked, see the plugin settings.`);
    expect(out).not.toContain(BAB_TOKEN);
    expect(out).not.toContain(BAB_TOKEN.slice(4, 20));
    expect(out).toContain("[redacted]");
    expect(out).toContain("and it worked");
  });

  it("masks a token that ends in a dash or underscore", () => {
    for (const tail of ["-", "_"]) {
      const t = BAB_TOKEN.slice(0, -1) + tail;
      expect(redact(`x ${t} y`)).toBe("x [redacted] y");
    }
  });

  it("masks it after a bab_token= label as well", () => {
    expect(redact(`bab_token=${BAB_TOKEN}`)).not.toContain(BAB_TOKEN.slice(4, 20));
  });

  it("leaves ordinary bab_ identifiers alone", () => {
    expect(redact("call bab_learn then bab_send and read bab_inbox")).toBe("call bab_learn then bab_send and read bab_inbox");
    const longName = "bab_" + "notification_subscription_cleanup".padEnd(43, "x");
    expect(redact(longName)).toBe(longName);
  });
});
