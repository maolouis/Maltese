#!/usr/bin/env python3
"""Minidump stack extractor + PDB public-symbol resolver (no WinDbg/cdb needed).

Usage:
  python minidump_stacks.py <dump.dmp> [--exe <maltese-assistant.exe>] [--pdb <maltese_assistant.pdb>]
                            [--ui-thread <tid>] [--frames 30]

What it does:
  1. Parses the MINIDUMP streams (header, thread list, module list, memory 64/32).
  2. Prints every thread: suspend count, Rip (mapped to module+offset), Rsp.
  3. Poor-man's stack walk: scans the thread stack from Rsp upwards for qwords that
     point into a loaded module's image -> candidate return addresses, in call order.
  4. If a PDB is given, resolves module RVA -> nearest public symbol (S_PUB32) so
     frames show real function names instead of raw offsets.
"""
import struct
import sys
import bisect
import os
import re

# ---------------------------------------------------------------- minidump ---


class Dump:
    def __init__(self, path):
        with open(path, "rb") as fh:
            self.buf = fh.read()
        b = self.buf
        sig, ver, nstreams, dir_rva = struct.unpack_from("<IIII", b, 0)
        if sig != 0x504D444D:
            raise SystemExit("not a minidump (bad signature 0x%x)" % sig)
        self.nstreams = nstreams
        self.streams = {}
        for i in range(nstreams):
            stype, size, rva = struct.unpack_from("<III", b, dir_rva + i * 12)
            self.streams.setdefault(stype, []).append((rva, size))
        # arch from SystemInfoStream (7)
        self.arch = None
        if 7 in self.streams:
            rva, _ = self.streams[7][0]
            self.arch = struct.unpack_from("<H", b, rva)[0]
        self.threads = self._threads()
        self.modules = self._modules()
        self.mem = self._memory()

    # -- streams -----------------------------------------------------------
    def _threads(self):
        out = []
        for rva, _ in self.streams.get(3, []):
            n = struct.unpack_from("<I", self.buf, rva)[0]
            off = rva + 4
            for _i in range(n):
                tid, susp, pri_c, pri = struct.unpack_from("<IIII", self.buf, off)
                teb = struct.unpack_from("<Q", self.buf, off + 16)[0]
                st_start, st_size, st_rva = struct.unpack_from("<QII", self.buf, off + 24)
                ctx_size, ctx_rva = struct.unpack_from("<II", self.buf, off + 40)
                out.append(dict(tid=tid, susp=susp, pri_class=pri_c, pri=pri, teb=teb,
                                stack_start=st_start, stack_size=st_size, stack_rva=st_rva,
                                ctx_rva=ctx_rva, ctx_size=ctx_size))
                off += 48
        return out

    def _modules(self):
        out = []
        for rva, _ in self.streams.get(4, []):
            n = struct.unpack_from("<I", self.buf, rva)[0]
            off = rva + 4
            for _i in range(n):
                base, size, _ck, _ts, name_rva = struct.unpack_from("<QIIII", self.buf, off)
                out.append(dict(base=base, size=size, name=self._minidump_string(name_rva)))
                off += 108
        out.sort(key=lambda m: m["base"])
        return out

    def _minidump_string(self, rva):
        if not rva:
            return ""
        n = struct.unpack_from("<I", self.buf, rva)[0]
        raw = self.buf[rva + 4: rva + 4 + n]
        try:
            return raw.decode("utf-16-le")
        except Exception:
            return repr(raw)

    def _memory(self):
        """List of (start, end, rva) covering image/stack memory in the dump."""
        ranges = []
        for rva, _ in self.streams.get(9, []):          # Memory64ListStream
            n, base_rva = struct.unpack_from("<QQ", self.buf, rva)
            off = rva + 16
            cur = base_rva
            for _i in range(n):
                start, size = struct.unpack_from("<QQ", self.buf, off)
                ranges.append((start, start + size, cur))
                cur += size
                off += 16
        for rva, _ in self.streams.get(5, []):          # MemoryListStream
            n = struct.unpack_from("<I", self.buf, rva)[0]
            off = rva + 4
            for _i in range(n):
                start, size, drva = struct.unpack_from("<QII", self.buf, off)
                ranges.append((start, start + size, drva))
                off += 16
        ranges.sort()
        return ranges

    # -- helpers -----------------------------------------------------------
    def read(self, start, size):
        """Read virtual memory from the dump (may be shorter if not dumped)."""
        out = bytearray()
        want = size
        pos = start
        while want > 0:
            i = bisect.bisect_right(self.mem, (pos, 1 << 64, 0)) - 1
            if i < 0:
                break
            rs, re_, rrva = self.mem[i]
            if pos < rs or pos >= re_:
                break
            avail = min(want, re_ - pos)
            off = rrva + (pos - rs)
            out += self.buf[off:off + avail]
            pos += avail
            want -= avail
        return bytes(out)

    def module_of(self, addr):
        for m in self.modules:
            if m["base"] <= addr < m["base"] + m["size"]:
                return m
        return None

    def describe(self, addr, syms=None):
        m = self.module_of(addr)
        if m is None:
            return "0x%x (no module)" % addr
        rva = addr - m["base"]
        short = os.path.basename(m["name"])
        tag = "%s+0x%x" % (short, rva)
        if syms:
            hit = syms.lookup(m["name"], rva)
            if hit:
                symname, srva = hit
                dem = rust_demangle_rough(symname)
                tag = ("%s!%s" % (short, dem)) if rva == srva else ("%s!%s+0x%x" % (short, dem, rva - srva))
            elif m["name"].lower().endswith(".dll"):
                ehit = export_lookup(m["name"], rva)
                if ehit:
                    ename, erva = ehit
                    tag = ("%s!%s" % (short, ename)) if rva == erva else ("%s!%s+0x%x" % (short, ename, rva - erva))
        return tag

    # -- context -----------------------------------------------------------
    def context(self, th):
        c = self.buf[th["ctx_rva"]: th["ctx_rva"] + th["ctx_size"]]
        if len(c) < 0x100:
            return None
        flags = struct.unpack_from("<I", c, 0x30)[0]
        regs = {}
        for name, off in (("Rax", 0x78), ("Rcx", 0x80), ("Rdx", 0x88), ("Rbx", 0x90),
                          ("Rsp", 0x98), ("Rbp", 0xA0), ("Rsi", 0xA8), ("Rdi", 0xB0),
                          ("R8", 0xB8), ("R9", 0xC0), ("R10", 0xC8), ("R11", 0xD0),
                          ("R12", 0xD8), ("R13", 0xE0), ("R14", 0xE8), ("R15", 0xF0),
                          ("Rip", 0xF8)):
            regs[name] = struct.unpack_from("<Q", c, off)[0]
        regs["flags"] = flags
        # lowercase aliases for backwards compatibility with the stack-walk code
        regs["rip"] = regs["Rip"]
        regs["rsp"] = regs["Rsp"]
        regs["rbp"] = regs["Rbp"]
        return regs


def rust_demangle_rough(name):
    """Very rough Rust v0 demangler: pull out length-prefixed path segments."""
    if not name.startswith("_R"):
        return name
    s = re.sub(r"Cs[0-9A-Za-z]{16}_", "", name[2:])
    parts = []
    i = 0
    while i < len(s):
        m = re.match(r"(\d+)", s[i:])
        if not m:
            i += 1
            continue
        n = int(m.group(1))
        start = i + len(m.group(1))
        seg = s[start:start + n]
        if len(seg) == n and re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", seg) and n > 1:
            parts.append(seg)
            i = start + n
        else:
            i = start
    return "::".join(parts) if parts else name


# --------------------------------------------------------------------- PDB ---

class Pdb:
    """Minimal MSF 7.00 reader -> S_PUB32 public symbols (RVA -> name)."""

    def __init__(self, path, pe_sections, funcs=None):
        with open(path, "rb") as fh:
            self.b = fh.read()
        b = self.b
        if b[:32] != b"Microsoft C/C++ MSF 7.00\r\n\x1aDS\x00\x00\x00":
            raise SystemExit("unsupported PDB magic")
        (page_size, _fpm, num_pages, dir_size, _res, block_map) = struct.unpack_from("<IIIIII", b, 32)
        self.page_size = page_size
        # block map -> directory pages
        n_dir_pages = (dir_size + page_size - 1) // page_size
        bm = struct.unpack_from("<%dI" % n_dir_pages, b, block_map * page_size)
        dirdata = b"".join(b[p * page_size:(p + 1) * page_size] for p in bm)[:dir_size]
        nstreams = struct.unpack_from("<I", dirdata, 0)[0]
        sizes = struct.unpack_from("<%dI" % nstreams, dirdata, 4)
        off = 4 + 4 * nstreams
        stream_pages = []
        for s in sizes:
            npages = (s + page_size - 1) // page_size
            stream_pages.append(struct.unpack_from("<%dI" % npages, dirdata, off))
            off += 4 * npages
        self.sizes = sizes
        self.stream_pages = stream_pages
        self.sections = pe_sections
        self.syms = []      # (rva, name)  public symbols
        self.procs = []     # (rva_start, rva_end, name)  S_GPROC32 with code extent
        self.funcs = funcs  # PE .pdata extents: [(begin_rva, end_rva)]
        self._load_publics()
        # exact-start name index (per .pdata function begin) -> [names]
        self.names_by_rva = {}
        for srva, name in self.syms:
            self.names_by_rva.setdefault(srva, []).append(rust_demangle_rough(name))
        print("[pdb] functions(.pdata)=%d, named function starts=%d"
              % (len(self.funcs or []), len(self.names_by_rva)), file=sys.stderr)

    def stream(self, idx):
        if idx is None or idx < 0 or idx >= len(self.stream_pages):
            return b""
        data = b"".join(self.b[p * self.page_size:(p + 1) * self.page_size]
                        for p in self.stream_pages[idx])
        return data[: self.sizes[idx]]

    def _load_publics(self):
        dbi = self.stream(3)
        if len(dbi) < 64:
            print("[pdb] DBI stream missing/short", file=sys.stderr)
            return
        gsi = struct.unpack_from("<H", dbi, 12)[0]
        pub = struct.unpack_from("<H", dbi, 16)[0]
        symrec = struct.unpack_from("<H", dbi, 20)[0]
        print("[pdb] DBI: global=%d publics=%d symrec=%d" % (gsi, pub, symrec), file=sys.stderr)
        data = self.stream(symrec)
        if not data:
            print("[pdb] symbol record stream empty", file=sys.stderr)
            return
        off = 0
        n = len(data)
        counts = {}
        while off + 4 <= n:
            reclen, rectype = struct.unpack_from("<HH", data, off)
            if reclen < 2 or off + 2 + reclen > n:
                break
            counts[rectype] = counts.get(rectype, 0) + 1
            if rectype == 0x110E:                    # S_PUB32
                _flags, sec_off, seg = struct.unpack_from("<IIH", data, off + 4)
                name = data[off + 4 + 10: off + 2 + reclen].split(b"\x00", 1)[0]
                if 1 <= seg <= len(self.sections):
                    rva = self.sections[seg - 1][0] + sec_off
                    self.syms.append((rva, name.decode("utf-8", "replace")))
            elif rectype == 0x1110:                  # S_GPROC32 (has code size)
                try:
                    _pp, _pe, _pn, code_len, _ds, _de, _ti, sec_off, seg = struct.unpack_from(
                        "<IIIIIIIHB", data, off + 4)
                    name = data[off + 4 + 35: off + 2 + reclen].split(b"\x00", 1)[0]
                    if 1 <= seg <= len(self.sections):
                        rva = self.sections[seg - 1][0] + sec_off
                        self.procs.append((rva, rva + code_len, name.decode("utf-8", "replace")))
                except Exception:
                    pass
            off += 2 + reclen
        self.syms.sort()
        self.procs.sort()
        print("[pdb] public symbols: %d / proc symbols: %d / rectypes: %s"
              % (len(self.syms), len(self.procs),
                 {hex(k): v for k, v in sorted(counts.items(), key=lambda kv: -kv[1])[:8]}),
              file=sys.stderr)

    def lookup(self, module_name, rva):
        """Return (name, function_start_rva) for the function containing rva.

        Anchors on the PE .pdata extent so the reported name is the real
        enclosing function even when /OPT:ICF folded several publics onto one
        address (in which case all folded names are joined with ' | ')."""
        if not module_name.lower().endswith((".exe", ".dll")):
            return None
        base = module_name.replace("\\", "/").rsplit("/", 1)[-1].lower()
        if base not in ("maltese-assistant.exe", "maltese_assistant.exe"):
            return None
        if self.funcs:
            i = bisect.bisect_right(self.funcs, (rva, 1 << 64)) - 1
            if i >= 0:
                lo, hi = self.funcs[i]
                if lo <= rva < hi:
                    names = self.names_by_rva.get(lo)
                    if names:
                        return (" | ".join(names), lo)
        # fallback: plain nearest public symbol (no size info -> keep it tight)
        if not self.syms:
            return None
        i = bisect.bisect_right(self.syms, (rva, "\uffff")) - 1
        if i < 0:
            return None
        srva, name = self.syms[i]
        if rva - srva > 0x200:
            return None
        return (name, srva)


_EXPORT_CACHE = {}


def pe_exports(path):
    """Return sorted [(rva, name)] from a PE's export directory (for system DLLs)."""
    if path in _EXPORT_CACHE:
        return _EXPORT_CACHE[path]
    out = []
    try:
        with open(path, "rb") as fh:
            b = fh.read()
        e_lfanew = struct.unpack_from("<I", b, 0x3C)[0]
        magic, = struct.unpack_from("<H", b, e_lfanew + 24)
        nsec, = struct.unpack_from("<H", b, e_lfanew + 6)
        opt_size, = struct.unpack_from("<H", b, e_lfanew + 20)
        dd = e_lfanew + 24 + (112 if magic == 0x20B else 96)
        exp_rva, exp_size = struct.unpack_from("<II", b, dd)
        if not exp_rva:
            _EXPORT_CACHE[path] = []
            return []
        sec_off = e_lfanew + 24 + opt_size

        def rva_to_off(rva):
            for i in range(nsec):
                o = sec_off + i * 40
                vs, va, raw_size, raw_ptr = struct.unpack_from("<IIII", b, o + 8)
                if va <= rva < va + max(vs, raw_size):
                    return raw_ptr + (rva - va)
            return None

        eo = rva_to_off(exp_rva)
        if eo is None:
            _EXPORT_CACHE[path] = []
            return []
        nnames, = struct.unpack_from("<I", b, eo + 24)
        funcs_rva, names_rva, ords_rva = struct.unpack_from("<III", b, eo + 28)
        fo, no, oo = rva_to_off(funcs_rva), rva_to_off(names_rva), rva_to_off(ords_rva)
        if None in (fo, no, oo):
            _EXPORT_CACHE[path] = []
            return []
        for i in range(nnames):
            name_off = rva_to_off(struct.unpack_from("<I", b, no + 4 * i)[0])
            if name_off is None:
                continue
            end = b.index(b"\x00", name_off)
            name = b[name_off:end].decode("ascii", "replace")
            ordinal, = struct.unpack_from("<H", b, oo + 2 * i)
            frva, = struct.unpack_from("<I", b, fo + 4 * ordinal)
            if frva:
                out.append((frva, name))
        out.sort()
    except Exception as e:
        print("[export] %s: %s" % (path, e), file=sys.stderr)
    _EXPORT_CACHE[path] = out
    return out


def export_lookup(path, rva):
    exps = pe_exports(path)
    if not exps:
        return None
    i = bisect.bisect_right(exps, (rva, "\uffff")) - 1
    if i < 0:
        return None
    srva, name = exps[i]
    # exported functions are contiguous-ish; allow a generous window
    if rva - srva > 0x10000:
        return None
    return (name, srva)


def pe_sections_full(path):
    """[(name, va, vsize, characteristics)] for every PE section."""
    with open(path, "rb") as fh:
        b = fh.read(0x4000)
    e_lfanew = struct.unpack_from("<I", b, 0x3C)[0]
    nsec, = struct.unpack_from("<H", b, e_lfanew + 6)
    opt_size, = struct.unpack_from("<H", b, e_lfanew + 20)
    sec_off = e_lfanew + 24 + opt_size
    out = []
    for i in range(nsec):
        o = sec_off + i * 40
        name = b[o:o + 8].rstrip(b"\x00").decode("ascii", "replace")
        vs, va, raw_size, raw_ptr, _r, _l, _nr, _nl, chars = struct.unpack_from("<IIIIIIHHI", b, o + 8)
        out.append((name, va, max(vs, raw_size), chars))
    return out


def pe_sections(path):
    with open(path, "rb") as fh:
        b = fh.read(0x4000)
    e_lfanew = struct.unpack_from("<I", b, 0x3C)[0]
    if b[e_lfanew:e_lfanew + 4] != b"PE\x00\x00":
        raise SystemExit("not a PE: %s" % path)
    nsec, = struct.unpack_from("<H", b, e_lfanew + 6)
    opt_size, = struct.unpack_from("<H", b, e_lfanew + 20)
    sec_off = e_lfanew + 24 + opt_size
    secs = []
    for i in range(nsec):
        o = sec_off + i * 40
        va, = struct.unpack_from("<I", b, o + 12)
        vs, = struct.unpack_from("<I", b, o + 8)
        secs.append((va, vs))
    return secs


def pe_functions(path, sections):
    """Parse the PE exception directory (.pdata) -> exact [begin,end) per function.

    This anchors symbol lookup to a real function start, which removes the
    "nearest public symbol" ambiguity caused by /OPT:ICF code folding."""
    with open(path, "rb") as fh:
        b = fh.read(0x2000)
    e_lfanew = struct.unpack_from("<I", b, 0x3C)[0]
    magic, = struct.unpack_from("<H", b, e_lfanew + 24)
    opt = e_lfanew + 24
    # data directories: PE32+ starts at optional-header offset 112, PE32 at 96
    dd = opt + (112 if magic == 0x20B else 96)
    n_dirs, = struct.unpack_from("<I", b, dd - 4)
    if n_dirs <= 3:
        return []
    exc_rva, exc_size = struct.unpack_from("<II", b, dd + 3 * 8)
    if not exc_rva or not exc_size:
        return []
    funcs = []
    # map RVA -> file offset through section headers
    nsec, = struct.unpack_from("<H", b, e_lfanew + 6)
    opt_size, = struct.unpack_from("<H", b, e_lfanew + 20)
    sec_off = e_lfanew + 24 + opt_size
    with open(path, "rb") as fh:
        full = fh.read()

    def rva_to_off(rva):
        for i in range(nsec):
            o = sec_off + i * 40
            vs, va, raw_size, raw_ptr = struct.unpack_from("<IIII", full, o + 8)
            if va <= rva < va + max(vs, raw_size):
                return raw_ptr + (rva - va)
        return None

    off = rva_to_off(exc_rva)
    if off is None:
        return []
    count = exc_size // 12
    for i in range(count):
        begin, end, _unwind = struct.unpack_from("<III", full, off + i * 12)
        if begin and end > begin:
            funcs.append((begin, end))
    funcs.sort()
    return funcs


# -------------------------------------------------------------------- main ---

def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 1
    dump_path = args[0]
    exe = pdb = None
    ui_tid = None
    probe = []
    data_scan_tid = None
    xref_targets = []
    xref_abs = []
    peek = []
    grep_sym = None
    nframes = 30
    i = 1
    while i < len(args):
        if args[i] == "--exe":
            exe = args[i + 1]; i += 2
        elif args[i] == "--pdb":
            pdb = args[i + 1]; i += 2
        elif args[i] == "--ui-thread":
            ui_tid = int(args[i + 1]); i += 2
        elif args[i] == "--probe":
            probe = [int(x, 16) for x in args[i + 1].split(",")]
            i += 2
        elif args[i] == "--data-scan":
            data_scan_tid = int(args[i + 1]); i += 2
        elif args[i] == "--xref-abs":
            xref_abs = [int(x, 16) for x in args[i + 1].split(",")]
            i += 2
        elif args[i] == "--peek":
            peek = [(int(a, 16), int(b, 16)) for a, b in
                    (x.split(":") for x in args[i + 1].split(","))]
            i += 2
        elif args[i] == "--grep-sym":
            grep_sym = re.compile(args[i + 1]); i += 2
        elif args[i] == "--frames":
            nframes = int(args[i + 1]); i += 2
        else:
            i += 1

    syms = None
    if pdb and exe:
        secs = pe_sections(exe)
        funcs = pe_functions(exe, secs)
        syms = Pdb(pdb, secs, funcs)

    d = Dump(dump_path)
    print("=== dump: %s" % dump_path)
    print("streams: %s" % {k: len(v) for k, v in sorted(d.streams.items())})
    print("arch=%s threads=%d modules=%d memory_ranges=%d"
          % (d.arch, len(d.threads), len(d.modules), len(d.mem)))
    mods = [m for m in d.modules if m["name"]]
    print("modules (%d):" % len(mods))
    for m in mods:
        print("  0x%016x %9d  %s" % (m["base"], m["size"], m["name"]))

    if data_scan_tid is not None or xref_targets:
        exe_mod = next((m for m in d.modules if m["name"].lower().endswith(".exe")), None)
        if exe_mod is None:
            print("no .exe module", file=sys.stderr)
            return 1
        base = exe_mod["base"]
        secs = pe_sections_full(exe_mod["name"]) if os.path.exists(exe_mod["name"]) else []

        def in_exe(addr):
            return base <= addr < base + exe_mod["size"]

        def is_code_addr(addr):
            rva = addr - base
            for name, va, vs, chars in secs:
                if va <= rva < va + vs:
                    return bool(chars & 0x20000000)   # IMAGE_SCN_MEM_EXECUTE
            return False

        def nearest_public(rva):
            if not syms or not syms.syms:
                return None
            k = bisect.bisect_right(syms.syms, (rva, "\uffff")) - 1
            if k < 0:
                return None
            a, nm = syms.syms[k]
            return (rust_demangle_rough(nm), a, rva - a)

        if data_scan_tid is not None:
            th = next((t for t in d.threads if t["tid"] == data_scan_tid), None)
            if th is None:
                print("tid %d not found" % data_scan_tid, file=sys.stderr)
                return 1
            ctx = d.context(th)
            print("\n=== registers of tid=%d ===" % data_scan_tid)
            for k, v in ctx.items():
                extra = ""
                if isinstance(v, int) and in_exe(v):
                    rva = v - base
                    nl = nearest_public(rva)
                    extra = "  exe+0x%x %s" % (rva, ("= %s+0x%x" % (nl[0], nl[2])) if nl else "")
                print("   %-4s 0x%016x%s" % (k, v, extra))
            start = ctx["Rsp"]
            raw = d.read(start, 0x800)
            print("\n=== tid=%d stack words pointing into exe static data (candidate Mutex/statics) ==="
                  % data_scan_tid)
            seen = {}
            for off in range(0, len(raw) - 8, 8):
                val = struct.unpack_from("<Q", raw, off)[0]
                if not in_exe(val) or is_code_addr(val):
                    continue
                rva = val - base
                nl = nearest_public(rva)
                name = ("%s+0x%x" % (nl[0], nl[2])) if nl else "(no symbol)"
                key = (rva, name)
                seen[key] = seen.get(key, 0) + 1
                if off <= 0x200:
                    print("   [rsp+0x%03x] 0x%016x exe+0x%-8x %s" % (off, val, rva, name))
            print("\n=== xref of those static addresses across all %d threads ===" % len(d.threads))
            for (rva, name), cnt in sorted(seen.items(), key=lambda kv: -kv[1]):
                addr = base + rva
                hits = []
                for t2 in d.threads:
                    if t2["tid"] == data_scan_tid:
                        continue
                    c2 = d.context(t2)
                    if c2 is None:
                        continue
                    raw2 = d.read(c2["Rsp"], 0x2000)
                    for off in range(0, len(raw2) - 8, 8):
                        if struct.unpack_from("<Q", raw2, off)[0] == addr:
                            hits.append((t2["tid"], off))
                            break
                if hits:
                    print("   exe+0x%x %-60s referenced by %d other thread(s): %s"
                          % (rva, name, len(hits),
                             ", ".join("tid%d@rsp+0x%x" % (a, b) for a, b in hits[:8])))

        for tgt in xref_targets:
            addr = base + tgt
            nl = nearest_public(tgt)
            print("\n=== xref exe+0x%x (%s) ===" % (tgt, (nl[0] + "+0x%x" % nl[2]) if nl else "?"))
            for t2 in d.threads:
                c2 = d.context(t2)
                if c2 is None:
                    continue
                raw2 = d.read(c2["Rsp"], 0x4000)
                for off in range(0, len(raw2) - 8, 8):
                    if struct.unpack_from("<Q", raw2, off)[0] == addr:
                        print("   tid=%d [rsp+0x%x]" % (t2["tid"], off))
                        break

    if grep_sym is not None and syms:
        print("\n=== public symbols matching %r (with .pdata extent) ===" % grep_sym.pattern)
        for srva, name in syms.syms:
            dem = rust_demangle_rough(name)
            if not grep_sym.search(dem):
                continue
            extent = ""
            j = bisect.bisect_right(syms.funcs, (srva, 1 << 64)) - 1
            if j >= 0 and syms.funcs[j][0] <= srva < syms.funcs[j][1]:
                extent = " func[0x%x,0x%x)" % syms.funcs[j]
            print("   0x%-9x %s%s" % (srva, dem, extent))

    if peek:
        print("\n=== peek raw memory ===")
        for addr, ln in peek:
            data = d.read(addr, ln)
            print("   0x%016x (%d bytes dumped): %s" % (addr, len(data), data[:64].hex()))
            for o in range(0, min(len(data), ln) - 3, 4):
                print("     +0x%02x u32=0x%08x u64=%s"
                      % (o, struct.unpack_from("<I", data, o)[0],
                         (struct.unpack_from("<Q", data, o)[0] if o + 8 <= len(data) else "-")))

    if xref_abs:
        print("\n=== absolute address xref across %d threads (stack 0x4000 + registers) ===" % len(d.threads))
        for addr in xref_abs:
            print("addr 0x%016x" % addr)
            for t2 in d.threads:
                c2 = d.context(t2)
                if c2 is None:
                    continue
                reg_hit = [k for k, v in c2.items() if isinstance(v, int) and v == addr]
                raw2 = d.read(c2["Rsp"], 0x4000)
                stack_hits = []
                for off in range(0, len(raw2) - 8, 8):
                    if struct.unpack_from("<Q", raw2, off)[0] == addr:
                        stack_hits.append(off)
                if reg_hit or stack_hits:
                    print("   tid=%-6d regs=%s stack_offsets=%s"
                          % (t2["tid"], ",".join(reg_hit) or "-",
                             ",".join("0x%x" % o for o in stack_hits[:12]) or "-"))

    if probe:
        print("\n=== probe (module RVA -> .pdata function + public symbols) ===")
        for rva in probe:
            print("rva 0x%x" % rva)
            if syms and syms.funcs:
                j = bisect.bisect_right(syms.funcs, (rva, 1 << 64)) - 1
                if j >= 0:
                    lo, hi = syms.funcs[j]
                    inside = lo <= rva < hi
                    print("   .pdata func [0x%x,0x%x) inside=%s delta_from_begin=0x%x"
                          % (lo, hi, inside, rva - lo))
                    for k in range(max(0, j - 2), min(len(syms.funcs), j + 3)):
                        a, b_ = syms.funcs[k]
                        nm = syms.names_by_rva.get(a)
                        print("     func 0x%x-0x%x %s" % (a, b_, (" | ".join(nm)) if nm else "(no public at start)"))
            if syms:
                k = bisect.bisect_right(syms.syms, (rva, "\uffff")) - 1
                for d_ in range(-2, 3):
                    idx = k + d_
                    if 0 <= idx < len(syms.syms):
                        a, nm = syms.syms[idx]
                        print("     public rva=0x%x delta=%+d %s" % (a, rva - a, rust_demangle_rough(nm)))

    # code-range cache for stack scanning
    code_ranges = [(m["base"], m["base"] + m["size"]) for m in d.modules]

    def is_code(addr):
        for lo, hi in code_ranges:
            if lo <= addr < hi:
                return True
        return False

    for th in d.threads:
        ctx = d.context(th)
        if ctx is None:
            print("\n--- tid=%d (no context)" % th["tid"])
            continue
        mark = "  <== UI THREAD" if ui_tid == th["tid"] else ""
        print("\n--- tid=%d susp=%d pri=%d rip=%s rsp=0x%x rbp=0x%x%s"
              % (th["tid"], th["susp"], th["pri"], d.describe(ctx["rip"], syms),
                 ctx["rsp"], ctx["rbp"], mark))
        # scan the stack for return addresses
        start = ctx["rsp"]
        limit = min(th["stack_start"] + th["stack_size"], start + 0x8000)
        raw = d.read(start, max(0, limit - start))
        frames = []
        for off in range(0, len(raw) - 8, 8):
            val = struct.unpack_from("<Q", raw, off)[0]
            if is_code(val):
                frames.append((start + off, val))
        shown = 0
        for addr, val in frames:
            _m = d.module_of(val)
            _extra = ""
            if _m is not None and _m["name"].lower().endswith(".exe"):
                _extra = "  rva=0x%x" % (val - _m["base"])
            print("      [rsp+0x%04x] %s%s" % (addr - start, d.describe(val, syms), _extra))
            shown += 1
            if shown >= nframes:
                print("      ... (%d more candidate frames)" % (len(frames) - shown))
                break
    return 0


if __name__ == "__main__":
    sys.exit(main())