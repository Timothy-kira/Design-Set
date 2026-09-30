"""Structural check on an exported MP4/WebM.

A MediaRecorder file can be non-empty and still be unusable - a WebM whose
clusters never landed, or an MP4 that never got its moov index. This reads the
top-level box list (MP4) or the Segment/Info sizes (WebM) and reports what is
actually inside, so a green "343 KB" in the UI means a playable file.
"""
import struct
import sys


def read_mp4(path):
    with open(path, "rb") as handle:
        data = handle.read()
    boxes = []
    offset = 0
    while offset + 8 <= len(data):
        (size,) = struct.unpack_from(">I", data, offset)
        kind = data[offset + 4:offset + 8].decode("latin-1")
        header = 8
        if size == 1:
            (size,) = struct.unpack_from(">Q", data, offset + 8)
            header = 16
        elif size == 0:
            size = len(data) - offset
        if size < header:
            break
        boxes.append((kind, size))
        offset += size
    return boxes


def read_duration(path):
    """Movie and media duration in seconds.

    This is the number that catches the real failure mode of a frame-pushed
    export: if the renderer outruns the encoder, MediaRecorder drops frames but
    keeps wall-clock timestamps, so the file can be complete and still be
    shorter than the length the user asked for.
    """
    with open(path, "rb") as handle:
        data = handle.read()
    out = []

    def parse(kind):
        index = 0
        while True:
            found = data.find(kind, index)
            if found == -1:
                break
            version = data[found + 4]
            if version == 1:
                timescale, duration = struct.unpack_from(">IQ", data, found + 20)
            else:
                timescale, duration = struct.unpack_from(">II", data, found + 12)
            if timescale:
                out.append((kind.decode("latin-1"), duration / timescale))
            index = found + 4

    parse(b"mvhd")
    parse(b"mdhd")
    return out


def fragment_timeline(path):
    """Sum sample durations across every trun in a fragmented MP4.

    mvhd/mdhd duration is useless here: MediaRecorder writes a placeholder and
    leaves the real length spread across the fragments. The trun entries are
    what a player actually adds up.
    """
    with open(path, "rb") as handle:
        data = handle.read()

    def boxes(start, end):
        offset = start
        while offset + 8 <= end:
            size = int.from_bytes(data[offset:offset + 4], "big")
            kind = data[offset + 4:offset + 8]
            header = 8
            if size == 1:
                size = int.from_bytes(data[offset + 8:offset + 16], "big")
                header = 16
            elif size == 0:
                size = end - offset
            if size < header:
                return
            yield kind, offset, size, header
            offset += size

    ticks = 0
    samples = 0
    for kind, offset, size, header in boxes(0, len(data)):
        if kind != b"moof":
            continue
        for sub, sub_offset, sub_size, sub_header in boxes(offset + header, offset + size):
            if sub != b"traf":
                continue
            for leaf, leaf_offset, leaf_size, leaf_header in boxes(sub_offset + sub_header, sub_offset + sub_size):
                if leaf != b"trun":
                    continue
                body = leaf_offset + leaf_header
                flags = int.from_bytes(data[body + 1:body + 4], "big")
                count = int.from_bytes(data[body + 4:body + 8], "big")
                cursor = body + 8
                if flags & 0x1:
                    cursor += 4          # data_offset
                if flags & 0x4:
                    cursor += 4          # first_sample_flags
                # Per-sample fields are each opt-in, so the stride has to be
                # derived from the flags: 0x305 means duration + size only,
                # 8 bytes per sample, not a fixed 16.
                stride = 0
                for flag in (0x100, 0x200, 0x400, 0x800):
                    if flags & flag:
                        stride += 4
                for _ in range(count):
                    if flags & 0x100:
                        ticks += int.from_bytes(data[cursor:cursor + 4], "big")
                    cursor += stride
                samples += count
    return samples, ticks


def count_frames(path):
    """Count samples in both layouts: stsz for a plain MP4, trun for the
    fragmented MP4 MediaRecorder actually writes."""
    with open(path, "rb") as handle:
        data = handle.read()
    stsz = 0
    index = 0
    while True:
        found = data.find(b"stsz", index)
        if found == -1:
            break
        (stsz_count,) = struct.unpack_from(">I", data, found + 12)
        stsz += stsz_count
        index = found + 4
    if stsz:
        return stsz, "stsz"

    trun = 0
    index = 0
    while True:
        found = data.find(b"trun", index)
        if found == -1:
            break
        # version(1) + flags(3), then sample_count(4)
        (samples,) = struct.unpack_from(">I", data, found + 8)
        trun += samples
        index = found + 4
    return trun, "trun"


def read_webm(path):
    with open(path, "rb") as handle:
        data = handle.read()
    (magic,) = struct.unpack_from(">I", data, 0)
    assert magic == 0x1A45DFA3, "not a Matroska/WebM file"
    return [
        "EBML header",
        "Segment" if b"Segment" in data[:64] else "?",
        "has Info" if b"\x15\x49\xa9\x66" in data else "no Info",
        "has Cluster" if b"\x1f\x43\xb6\x75" in data else "no Cluster",
    ]


def main():
    path = sys.argv[1]
    with open(path, "rb") as handle:
        head = handle.read(4)
    print("%s  %d bytes" % (path, len(open(path, "rb").read())))
    if head == b"\x1a\x45\xdf\xa3":
        print("WebM:", ", ".join(read_webm(path)))
        return
    boxes = read_mp4(path)
    print("MP4 top-level boxes:", ", ".join("%s(%d)" % (k, s) for k, s in boxes))
    kinds = {k for k, _ in boxes}
    for required in ("ftyp", "moov", "mdat"):
        print("  %s %s" % (required, "present" if required in kinds else "MISSING"))
    frames, source = count_frames(path)
    print("  video samples: %d (via %s)" % (frames, source))
    if source == "trun":
        frag_frames, ticks = fragment_timeline(path)
        print("  fragment timeline: %d samples, %d ticks" % (frag_frames, ticks))
        for kind, seconds in read_duration(path):
            if kind == "mdhd":
                timescale = seconds[1] if isinstance(seconds, tuple) else None
        # mdhd supplies the tick rate the ticks above are counted in.
        with open(path, "rb") as handle:
            blob = handle.read()
        at = blob.find(b"mdhd")
        if at != -1:
            rate = int.from_bytes(blob[at + 24:at + 28], "big")
            if rate:
                print("  PLAYBACK LENGTH: %.2f s  (%d ticks / %d per second)"
                      % (ticks / rate, ticks, rate))


if __name__ == "__main__":
    main()
