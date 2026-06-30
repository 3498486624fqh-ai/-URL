import { FieldExecuteCode, FieldType, FormItemComponent, fieldDecoratorKit } from "dingtalk-docs-cool-app/dist-node/module/fields";
import { decode as decodeJpeg } from "jpeg-js";
import jsQR from "jsqr";
import { PNG } from "pngjs";

const { t } = fieldDecoratorKit;

fieldDecoratorKit.setDomainList([
  "alidocs.dingtalk.com",
  "alidocs2-zjk-cdn.dingtalk.com",
  "alidocs.oss-cn-zhangjiakou.aliyuncs.com",
  "aliyuncs.com",
  "dingtalk.com",
  "wostatic.cn",
]);

type Attachment = {
  name: string;
  type: string;
  size: number;
  tmp_url: string;
};

type QRCodeFormData = {
  qrImage: Attachment[];
};

function isPng(buf: Buffer) {
  return buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

function isJpeg(buf: Buffer) {
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

function isBmp(buf: Buffer) {
  return buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d;
}

function decodeImage(buffer: Buffer, mimeType?: string) {
  const mt = (mimeType || "").toLowerCase();

  if (isBmp(buffer)) {
    const dataOffset = buffer.readUInt32LE(10);
    const width = buffer.readInt32LE(18);
    const heightAbs = Math.abs(buffer.readInt32LE(22));
    const bitsPerPixel = buffer.readUInt16LE(28);
    if (bitsPerPixel !== 32) throw new Error("bmp_unsupported_bpp");
    const rowSize = width * 4;
    const rgba = Buffer.alloc(rowSize * heightAbs);
    for (let y = 0; y < heightAbs; y++) {
      const srcRow = heightAbs - 1 - y;
      const srcOff = dataOffset + srcRow * rowSize;
      const dstOff = y * rowSize;
      for (let x = 0; x < width; x++) {
        const s = srcOff + x * 4;
        const d = dstOff + x * 4;
        rgba[d] = buffer[s + 2];
        rgba[d + 1] = buffer[s + 1];
        rgba[d + 2] = buffer[s];
        rgba[d + 3] = buffer[s + 3];
      }
    }
    return { data: rgba as any, width, height: heightAbs };
  }

  if (isPng(buffer) || mt.includes("png")) {
    const png = PNG.sync.read(buffer);
    return { data: png.data as any, width: png.width, height: png.height };
  }

  if (isJpeg(buffer) || mt.includes("jpg") || mt.includes("jpeg")) {
    const jpeg = decodeJpeg(buffer, { useTArray: true });
    return { data: jpeg.data as any, width: jpeg.width, height: jpeg.height };
  }

  const hex = buffer.slice(0, 4).toString("hex");
  throw new Error("unsupported_image_type:first_bytes=" + hex + ",size=" + buffer.length);
}

function resizeRGBA(
  src: Uint8Array | Uint8ClampedArray,
  srcW: number,
  srcH: number,
  maxDim: number,
) {
  let w = srcW;
  let h = srcH;
  if (w > maxDim || h > maxDim) {
    const ratio = maxDim / Math.max(w, h);
    w = Math.round(w * ratio);
    h = Math.round(h * ratio);
  } else {
    return { data: new Uint8ClampedArray(src), width: w, height: h };
  }

  const dst = new Uint8ClampedArray(w * h * 4);
  const xRatio = srcW / w;
  const yRatio = srcH / h;

  for (let dy = 0; dy < h; dy++) {
    const sy = Math.floor(dy * yRatio);
    const srcRow = sy * srcW * 4;
    const dstRow = dy * w * 4;
    for (let dx = 0; dx < w; dx++) {
      const sx = Math.floor(dx * xRatio);
      const si = srcRow + sx * 4;
      const di = dstRow + dx * 4;
      dst[di] = src[si];
      dst[di + 1] = src[si + 1];
      dst[di + 2] = src[si + 2];
      dst[di + 3] = src[si + 3];
    }
  }

  return { data: dst, width: w, height: h };
}

async function readImageBufferFromUrl(context: any, url: string) {
  const response = await context.fetch(url, { method: "GET" });
  if (!response.ok) throw new Error("download_failed:" + response.status);
  return Buffer.from(await response.arrayBuffer());
}

async function decodeQRCodeFromUrl(context: any, attachment: Attachment) {
  const buffer = await readImageBufferFromUrl(context, attachment.tmp_url);
  const raw = decodeImage(buffer, attachment.type);
  const MAX_DIM = 1200;
  const scaled = resizeRGBA(raw.data, raw.width, raw.height, MAX_DIM);
  const clampedData = new Uint8ClampedArray(
    scaled.data.buffer,
    scaled.data.byteOffset,
    scaled.data.byteLength,
  );

  let result = jsQR(clampedData, scaled.width, scaled.height);
  if (!result) {
    const gray = new Uint8ClampedArray(scaled.width * scaled.height * 4);
    for (let i = 0; i < scaled.width * scaled.height; i++) {
      const off = i * 4;
      const v = Math.round(0.299 * clampedData[off] + 0.587 * clampedData[off + 1] + 0.114 * clampedData[off + 2]);
      gray[off] = v;
      gray[off + 1] = v;
      gray[off + 2] = v;
      gray[off + 3] = clampedData[off + 3];
    }
    result = jsQR(gray, scaled.width, scaled.height);
  }

  if (!result || !result.data) {
    throw new Error(
      "decode_no_qr_found:type=" + (attachment.type || "none") +
      ",name=" + (attachment.name || "") +
      ",orig_w=" + raw.width +
      ",orig_h=" + raw.height +
      ",scaled_w=" + scaled.width +
      ",scaled_h=" + scaled.height
    );
  }

  return result.data.trim() || "";
}

fieldDecoratorKit.setDecorator({
  name: "二维码转URL",
  i18nMap: {
    "zh-CN": {
      qrImageLabel: "二维码来源",
      noAttachment: "请先上传二维码图片",
      missingUrl: "二维码图片缺少可读取的附件链接",
      decodeFailed: "未识别到二维码，请上传清晰、完整的二维码图片",
      processFailed: "二维码解析失败，请稍后重试或更换图片",
    },
    "en-US": {
      qrImageLabel: "QR Code Source",
      noAttachment: "Please upload a QR code image first",
      missingUrl: "The QR image does not include a readable attachment URL",
      decodeFailed: "No QR code was detected. Please upload a clear and complete QR image",
      processFailed: "Failed to decode the QR code. Please retry later or use another image",
    },
    "ja-JP": {
      qrImageLabel: "QRコードソース",
      noAttachment: "QRコード画像をアップロードしてください",
      missingUrl: "QR画像に読み取り可能な添付リンクがありません",
      decodeFailed: "QRコードを検出できません。鮮明で完全なQR画像をアップロードしてください",
      processFailed: "QRコードの解析に失敗しました。後でもう一度試すか、別の画像を使用してください",
    },
  },
  errorMessages: {
    no_attachment: t("noAttachment"),
    missing_url: t("missingUrl"),
    decode_failed: t("decodeFailed"),
    process_failed: t("processFailed"),
  },
  formItems: [
    {
      key: "qrImage",
      label: t("qrImageLabel"),
      component: FormItemComponent.FieldSelect,
      props: { mode: "single", supportTypes: [FieldType.Attachment] },
      validator: { required: true },
    },
  ],
  resultType: {
    type: FieldType.Text,
  },
  execute: async (context, formData: QRCodeFormData) => {
    try {
      const attachments = formData.qrImage || [];
      const attachment = attachments[0];
      if (!attachment) return { code: FieldExecuteCode.Error, data: "", errorMessage: "no_attachment" };
      if (!attachment.tmp_url) return { code: FieldExecuteCode.Error, data: "", errorMessage: "missing_url" };
      const decodedUrl = await decodeQRCodeFromUrl(context, attachment);
      if (!decodedUrl) return { code: FieldExecuteCode.Error, data: "", errorMessage: "decode_failed" };
      return { code: FieldExecuteCode.Success, data: decodedUrl };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log("decode qrcode failed", msg);
      return {
        code: FieldExecuteCode.Error,
        data: "",
        msg: msg,
        errorMessage: "process_failed",
      };
    }
  },
});

export default fieldDecoratorKit;