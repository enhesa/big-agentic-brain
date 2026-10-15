import { describe, it, expect } from "vitest";
import { proxyNameMatchesEmail } from "../lib/identity";

describe("proxyNameMatchesEmail", () => {
  it.each([
    ["Alice Example", "alice.example@example.com"],
    ["alice example", "alice.example@example.com"],
    ["Alice (Ally) Example", "alice.example@example.com"],
    ["Alice Petrovich Example", "alice.example@example.com"],
    ["Bob Van der Example", "bob.vanderexample@example.com"],
    ["Bob Van Der Example", "bob.van.der.example@example.com"],
    ["Bob-Luc Van-Der-Example", "bob-luc.van-der-example@example.com"],
    ["Bob Luc Van Der Example", "bob-luc.van-der-example@example.com"],
    ["Jo\u00e3o Silva", "joao.silva@example.com"],
    ["  Alice   Example ", "alice.example@example.com"],
  ])("accepts %s for %s", (name, email) => {
    expect(proxyNameMatchesEmail(name, email)).toBe(true);
  });

  it.each([
    ["Anna Smith", "adam.smith@example.com"],
    ["Adam Smithson", "adam.smith@example.com"],
    ["Adam Blacksmith", "adam.smith@example.com"],
    ["Adam", "adam.smith@example.com"],
    ["Smith", "adam.smith@example.com"],
    ["Smith Adam", "adam.smith@example.com"],
    ["Adamo Smith", "adam.smith@example.com"],
    ["", "adam.smith@example.com"],
    ["(Adam) (Smith)", "adam.smith@example.com"],
  ])("rejects %s for %s", (name, email) => {
    expect(proxyNameMatchesEmail(name, email)).toBe(false);
  });

  it("rejects a missing name", () => {
    expect(proxyNameMatchesEmail(null, "adam.smith@example.com")).toBe(false);
    expect(proxyNameMatchesEmail(undefined, "adam.smith@example.com")).toBe(false);
  });
});
