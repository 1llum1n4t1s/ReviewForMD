/**
 * 純 JS ZIP ライタ（STORE 法・依存ゼロ）
 *
 * Teams チャットの「添付ごと ZIP」エクスポートで、トランスクリプト本文と
 * 添付ファイル/画像を 1 アーカイブに同梱するために使う。
 *
 * 設計方針:
 *   - 圧縮しない (STORE method = 0)。画像/Office ファイルは既に圧縮済みなので
 *     再圧縮の利得が小さく、無圧縮なら元の品質をそのまま保てる。
 *   - 外部ライブラリ・ビルドステップを増やさない（プロジェクト方針 "Vanilla JS"）。
 *   - ファイル名は常に UTF-8（汎用フラグ bit 11）で書く。
 *   - 4GB 超のファイル / 中央ディレクトリ、エントリ 65535 超のときだけ
 *     ZIP64 フィールドを付与する（通常はブラウザのメモリ上限が先に来るため未到達）。
 *
 * 全コードはこのプロジェクトのためのオリジナル実装。
 */
var RfmdZip = RfmdZip || (() => {
  /** 32bit フィールドで表せる上限。これを超えたら ZIP64 を使う。 */
  const U32_MAX = 0xffffffff;

  /** CRC-32 テーブル（初回利用時に生成） */
  let _crcTable = null;

  function _getCrcTable() {
    if (_crcTable) return _crcTable;
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      t[n] = c >>> 0;
    }
    _crcTable = t;
    return t;
  }

  /** バイト列の CRC-32（符号なし 32bit）を計算する。 */
  function _crc32(bytes) {
    const t = _getCrcTable();
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  /** DataView に 64bit リトルエンディアンで書き込む（値は 2^53 未満を前提）。 */
  function _setUint64(dv, pos, value) {
    const lo = value >>> 0;
    const hi = Math.floor(value / 0x100000000) >>> 0;
    dv.setUint32(pos, lo, true);
    dv.setUint32(pos + 4, hi, true);
  }

  /** Date を DOS 形式の {time, date}（各 16bit）に変換する。 */
  function _dosDateTime(d) {
    let year = d.getFullYear();
    if (year < 1980) year = 1980;
    const time =
      (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date =
      ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time: time & 0xffff, date: date & 0xffff };
  }

  /** entry.data を Uint8Array に正規化する（文字列は UTF-8 エンコード）。 */
  function _toBytes(data, enc) {
    if (typeof data === 'string') return enc.encode(data);
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    // フォールバック: 文字列化してエンコード
    return enc.encode(String(data));
  }

  /**
   * ZIP アーカイブを生成して Blob で返す。
   * @param {Array<{name: string, data: string|Uint8Array|ArrayBuffer}>} entries
   * @returns {Blob} application/zip の Blob
   */
  function create(entries) {
    const enc = new TextEncoder();
    /** @type {Array<Uint8Array>} Blob に渡す断片（巨大な単一コピーを避ける） */
    const parts = [];
    let offset = 0; // ローカルヘッダ領域の現在オフセット
    const central = []; // 中央ディレクトリ用メタ

    const now = new Date();
    const { time: dosTime, date: dosDate } = _dosDateTime(now);

    for (const entry of entries || []) {
      const nameBytes = enc.encode(entry.name);
      const data = _toBytes(entry.data, enc);
      const size = data.length;
      const crc = _crc32(data);
      // このエントリ自身でローカルヘッダ ZIP64 が要るか（サイズ or 現オフセット超過）
      const localZip64 = size >= U32_MAX || offset >= U32_MAX;

      // ── ローカルヘッダの ZIP64 extra（必要時のみ）──
      let localExtra = new Uint8Array(0);
      if (localZip64) {
        localExtra = new Uint8Array(20); // header(2)+size(2)+uncompressed(8)+compressed(8)
        const ev = new DataView(localExtra.buffer);
        ev.setUint16(0, 0x0001, true);
        ev.setUint16(2, 16, true);
        _setUint64(ev, 4, size);
        _setUint64(ev, 12, size);
      }

      // ── ローカルファイルヘッダ（30 バイト固定 + 名前 + extra）──
      const lh = new Uint8Array(30 + nameBytes.length + localExtra.length);
      const lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true); // PK\x03\x04
      lv.setUint16(4, localZip64 ? 45 : 20, true); // version needed
      lv.setUint16(6, 0x0800, true); // 汎用フラグ: UTF-8 名
      lv.setUint16(8, 0, true); // 圧縮方式: STORE
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, localZip64 ? U32_MAX : size, true); // compressed
      lv.setUint32(22, localZip64 ? U32_MAX : size, true); // uncompressed
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, localExtra.length, true);
      lh.set(nameBytes, 30);
      lh.set(localExtra, 30 + nameBytes.length);

      parts.push(lh);
      parts.push(data);

      central.push({ nameBytes, crc, size, offset });
      offset += lh.length + size;
    }

    // ── 中央ディレクトリ ──
    const centralStart = offset;
    let centralSize = 0;

    for (const c of central) {
      const incSize = c.size >= U32_MAX; // サイズが 32bit に収まらない
      const incOff = c.offset >= U32_MAX; // オフセットが 32bit に収まらない
      const cdZip64 = incSize || incOff;

      // ZIP64 extra: 32bit で 0xFFFFFFFF にした項目だけを順序通り格納する
      let cdExtra = new Uint8Array(0);
      if (cdZip64) {
        let extraBody = 0;
        if (incSize) extraBody += 16; // uncompressed(8) + compressed(8)
        if (incOff) extraBody += 8; // local header offset(8)
        cdExtra = new Uint8Array(4 + extraBody);
        const ev = new DataView(cdExtra.buffer);
        ev.setUint16(0, 0x0001, true);
        ev.setUint16(2, extraBody, true);
        let p = 4;
        if (incSize) {
          _setUint64(ev, p, c.size);
          p += 8;
          _setUint64(ev, p, c.size);
          p += 8;
        }
        if (incOff) {
          _setUint64(ev, p, c.offset);
          p += 8;
        }
      }

      // ── 中央ディレクトリヘッダ（46 バイト固定 + 名前 + extra）──
      const ch = new Uint8Array(46 + c.nameBytes.length + cdExtra.length);
      const dv = new DataView(ch.buffer);
      dv.setUint32(0, 0x02014b50, true); // PK\x01\x02
      dv.setUint16(4, (0 << 8) | (cdZip64 ? 45 : 20), true); // version made by (host=MS-DOS)
      dv.setUint16(6, cdZip64 ? 45 : 20, true); // version needed
      dv.setUint16(8, 0x0800, true); // 汎用フラグ: UTF-8 名
      dv.setUint16(10, 0, true); // 圧縮方式: STORE
      dv.setUint16(12, dosTime, true);
      dv.setUint16(14, dosDate, true);
      dv.setUint32(16, c.crc, true);
      dv.setUint32(20, incSize ? U32_MAX : c.size, true); // compressed
      dv.setUint32(24, incSize ? U32_MAX : c.size, true); // uncompressed
      dv.setUint16(28, c.nameBytes.length, true);
      dv.setUint16(30, cdExtra.length, true);
      dv.setUint16(32, 0, true); // file comment length
      dv.setUint16(34, 0, true); // disk number start
      dv.setUint16(36, 0, true); // internal attrs
      dv.setUint32(38, 0, true); // external attrs
      dv.setUint32(42, incOff ? U32_MAX : c.offset, true); // local header offset
      ch.set(c.nameBytes, 46);
      ch.set(cdExtra, 46 + c.nameBytes.length);

      parts.push(ch);
      centralSize += ch.length;
    }

    const totalEntries = central.length;
    const needZip64Eocd =
      totalEntries > 0xffff ||
      centralStart >= U32_MAX ||
      centralSize >= U32_MAX;

    // ── ZIP64 EOCD レコード + ロケータ（必要時のみ）──
    if (needZip64Eocd) {
      const z = new Uint8Array(56);
      const dv = new DataView(z.buffer);
      dv.setUint32(0, 0x06064b50, true); // PK\x06\x06
      _setUint64(dv, 4, 44); // この後のレコードサイズ（= 56 - 12）
      dv.setUint16(12, 45, true); // version made by
      dv.setUint16(14, 45, true); // version needed
      dv.setUint32(16, 0, true); // this disk
      dv.setUint32(20, 0, true); // disk with central dir
      _setUint64(dv, 24, totalEntries); // entries on this disk
      _setUint64(dv, 32, totalEntries); // total entries
      _setUint64(dv, 40, centralSize);
      _setUint64(dv, 48, centralStart);
      parts.push(z);

      const loc = new Uint8Array(20);
      const lv = new DataView(loc.buffer);
      lv.setUint32(0, 0x07064b50, true); // PK\x06\x07
      lv.setUint32(4, 0, true); // disk with zip64 eocd
      _setUint64(lv, 8, centralStart + centralSize); // zip64 eocd のオフセット
      lv.setUint32(16, 1, true); // total disks
      parts.push(loc);
    }

    // ── EOCD（End Of Central Directory）──
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true); // PK\x05\x06
    ev.setUint16(4, 0, true); // this disk
    ev.setUint16(6, 0, true); // disk with central dir
    ev.setUint16(8, totalEntries > 0xffff ? 0xffff : totalEntries, true);
    ev.setUint16(10, totalEntries > 0xffff ? 0xffff : totalEntries, true);
    ev.setUint32(12, centralSize >= U32_MAX ? U32_MAX : centralSize, true);
    ev.setUint32(16, centralStart >= U32_MAX ? U32_MAX : centralStart, true);
    ev.setUint16(20, 0, true); // comment length
    parts.push(eocd);

    return new Blob(parts, { type: 'application/zip' });
  }

  return { create };
})();
