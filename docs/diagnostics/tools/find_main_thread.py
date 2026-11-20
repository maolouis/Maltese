#!/usr/bin/env python3
"""Identify the process MAIN thread in a minidump by finding the stack that
contains the CRT startup frame (return address near the PE entry point).

Usage: python find_main_thread.py <dump> <exe>
"""
import struct
import sys
import bisect


def load(path):
    with open(path, "rb") as f:
        return f.read()


class D:
    def __init__(self, p):
        self.b = load(p)
        sig, ver, n, dir_rva = struct.unpack_from("<IIII", self.b, 0)
        assert sig == 0x504D444D
        self.streams = {}
        for i in range(n):
            t, s, r = struct.unpack_from("<III", self.b, dir_rva + i * 12)
            self.streams.setdefault(t, []).append((r, s))
        self.threads, self.modules, self.mem = [], [], []
        for rva, _ in self.streams.get(3, []):
            cnt = struct.unpack_from("<I", self.b, rva)[0]
            o = rva + 4
            for _i in range(cnt):
                tid, susp = struct.unpack_from("<II", self.b, o)
                teb = struct.unpack_from("<Q", self.b, o + 16)[0]
                ss, sz, srva = struct.unpack_from("<QII", self.b, o + 24)
                cs, crva = struct.unpack_from("<II", self.b, o + 40)
                self.threads.append(dict(tid=tid, susp=susp, teb=teb, stack_start=ss,
                                         stack_size=sz, ctx_rva=crva, ctx_size=cs))
                o += 48
        for rva, _ in self.streams.get(4, []):
            cnt = struct.unpack_from("<I", self.b, rva)[0]
            o = rva + 4
            for _i in range(cnt):
                base, size, _ck, _ts, name_rva = struct.unpack_from("<QIIII", self.b, o)
                ln = struct.unpack_from("<I", self.b, name_rva)[0]
                name = self.b[name_rva + 4:name_rva + 4 + ln].decode("utf-16-le")
                self.modules.append(dict(base=base, size=size, name=name))
                o += 108
        for rva, _ in self.streams.get(9, []):
            cnt, base_rva = struct.unpack_from("<QQ", self.b, rva)
            o = rva + 16
            cur = base_rva
            for _i in range(cnt):
                s, z = struct.unpack_from("<QQ", self.b, o)
                self.mem.append((s, s + z, cur))
                cur += z
                o += 16
        for rva, _ in self.streams.get(5, []):
            cnt = struct.unpack_from("<I", self.b, rva)[0]
            o = rva + 4
            for _i in range(cnt):
                s, z, drva = struct.unpack_from("<QII", self.b, o)
                self.mem.append((s, s + z, drva))
                o += 16
        self.mem.sort()

    def read(self, start, size):
        out = bytearray()
        pos, want = start, size
        while want > 0:
            i = bisect.bisect_right(self.mem, (pos, 1 << 64, 0)) - 1
            if i < 0:
                break
            rs, re_, rrva = self.mem[i]
            if pos < rs or pos >= re_:
                break
            avail = min(want, re_ - pos)
            out += self.b[rrva + (pos - rs): rrva + (pos - rs) + avail]
            pos += avail
            want -= avail
        return bytes(out)


def pe_entry(path):
    with open(path, "rb") as f:
        b = f.read(0x2000)
    e = struct.unpack_from("<I", b, 0x3C)[0]
    magic = struct.unpack_from("<H", b, e + 24)[0]
    off = e + 24 + (16 if magic == 0x20B else 16)
    entry = struct.unpack_from("<I", b, off)[0]
    image_base = struct.unpack_from("<Q", b, e + 24 + 24)[0] if magic == 0x20B else 0
    return entry, image_base


def main():
    dump, exe = sys.argv[1], sys.argv[2]
    entry_rva, _ = pe_entry(exe)
    d = D(dump)
    exe_mod = next(m for m in d.modules if m["name"].lower().endswith(".exe"))
    lo, hi = exe_mod["base"] + entry_rva - 0x600, exe_mod["base"] + entry_rva + 0x600
    print("entry_rva=0x%x window=[0x%x,0x%x)" % (entry_rva, lo, hi))
    hits = []
    for t in d.threads:
        raw = d.read(t["stack_start"], t["stack_size"])
        found = []
        for off in range(0, len(raw) - 8, 8):
            v = struct.unpack_from("<Q", raw, off)[0]
            if lo <= v < hi:
                found.append((off, v - exe_mod["base"]))
        if found:
            hits.append((t["tid"], t["stack_size"], found))
    print("\nthreads whose stack holds a CRT-startup-range address (main thread candidates):")
    for tid, ssz, found in hits:
        print("  tid=%-6d stack_size=0x%-8x frames=%s"
              % (tid, ssz, ", ".join("+0x%x(rva 0x%x)" % (o, r) for o, r in found[:6])))


if __name__ == "__main__":
    main()