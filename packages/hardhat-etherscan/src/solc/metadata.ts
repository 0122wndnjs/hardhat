import type cbor from "cbor";
import debug from "debug";
import util from "util";

interface MetadataDescription {
  solcVersion: string;
  metadataSectionSizeInBytes: number;
}

export const METADATA_LENGTH_SIZE = 2;
export const METADATA_PRESENT_SOLC_NOT_FOUND_VERSION_RANGE = "0.4.7 - 0.5.8";
export const METADATA_ABSENT_VERSION_RANGE = "<0.4.7";

const log = debug("hardhat:hardhat-etherscan:metadata");

export function inferSolcVersion(bytecode: Buffer): MetadataDescription {
  // We want to provide our best inference here.
  // We can infer that some solidity compiler releases couldn't have produced this bytecode.
  // Solc v0.4.7 was the first compiler to introduce metadata into the generated bytecode.
  // See https://solidity.readthedocs.io/en/v0.4.7/miscellaneous.html#contract-metadata
  // Solc v0.4.26, the last release for the v0.4 series, does not feature the compiler version in its emitted metadata.
  // See https://solidity.readthedocs.io/en/v0.4.26/metadata.html#encoding-of-the-metadata-hash-in-the-bytecode
  // Solc v0.5.9 was the first compiler to introduce its version into the metadata.
  // See https://solidity.readthedocs.io/en/v0.5.9/metadata.html#encoding-of-the-metadata-hash-in-the-bytecode
  // Solc v0.6.0 features compiler version metadata.
  // See https://solidity.readthedocs.io/en/v0.6.0/metadata.html#encoding-of-the-metadata-hash-in-the-bytecode
  let solcMetadata;
  let metadataSectionSizeInBytes;
  try {
    const metadata = decodeSolcMetadata(bytecode);
    log(`Metadata decoded: ${util.inspect(metadata.decoded)}`);
    metadataSectionSizeInBytes = metadata.metadataSectionSizeInBytes;
    solcMetadata = metadata.decoded.solc;
  } catch (error) {
    // The decoding failed. Unfortunately, our only option is to assume that this bytecode was emitted by an old version.
    // Technically, this bytecode could have been emitted by a compiler for another language altogether.
    // TODO: add detection logic for other compilers if they become relevant?
    log("Could not decode metadata.");
    return {
      metadataSectionSizeInBytes: 0,
      solcVersion: METADATA_ABSENT_VERSION_RANGE,
    };
  }

  if (solcMetadata instanceof Buffer) {
    if (solcMetadata.length === 3) {
      const [major, minor, patch] = solcMetadata;
      const solcVersion = `${major}.${minor}.${patch}`;
      log(`Solc version detected in bytecode: ${solcVersion}`);
      return { metadataSectionSizeInBytes, solcVersion };
    }
    log(
      `Found solc version field with ${solcMetadata.length} elements instead of three!`
    );
  }

  // The embedded metadata was successfully decoded but there was no solc version in it.
  log(`Could not detect solidity version in metadata.`);
  return {
    metadataSectionSizeInBytes,
    solcVersion: METADATA_PRESENT_SOLC_NOT_FOUND_VERSION_RANGE,
  };
}

export function decodeSolcMetadata(bytecode: Buffer) {
  const metadataSectionLength = getSolcMetadataSectionLength(bytecode);
  // The metadata and its length are in the last few bytes.
  const metadataPayload = bytecode.slice(
    -metadataSectionLength,
    -METADATA_LENGTH_SIZE
  );

  log(`Read metadata length ${metadataSectionLength}`);

  const lastMetadataBytes = metadataPayload.slice(-100);
  log(
    `Last ${
      lastMetadataBytes.length
    } bytes of metadata: ${lastMetadataBytes.toString("hex")}`
  );

  const { decodeFirstSync }: typeof cbor = require("cbor");
  // The documentation for decodeFirst mentions the `required` option even though
  // the type information is missing it.
  // See http://hildjj.github.io/node-cbor/Decoder.html#.decodeFirst
  const options: cbor.DecoderOptions = { required: true } as any;
  const decoded = decodeFirstSync(metadataPayload, options);
  return {
    decoded,
    metadataSectionSizeInBytes: metadataSectionLength,
  };
}

export function getSolcMetadataSectionLength(bytecode: Buffer) {
  return (
    bytecode.slice(-METADATA_LENGTH_SIZE).readUInt16BE(0) + METADATA_LENGTH_SIZE
  );
}

/**
 * This function helps us measure the size of the executable section
 * without actually decoding the whole bytecode string.
 *
 * This is useful because the runtime object emitted by the compiler
 * may contain nonhexadecimal characters due to link placeholders.
 */
export function measureExecutableSectionLength(bytecode: string): number {
  if (bytecode.startsWith("0x")) {
    bytecode = bytecode.slice(2);
  }

  // `Buffer.from` will return a buffer that contains bytes up until the last decodable byte.
  // To work around this we'll just slice the relevant part of the bytecode.
  const metadataLengthSlice = Buffer.from(
    bytecode.slice(-METADATA_LENGTH_SIZE * 2),
    "hex"
  );

  // If, for whatever reason, the bytecode is so small that we can't even read two bytes off it,
  // return the size of the entire bytecode.
  if (metadataLengthSlice.length !== METADATA_LENGTH_SIZE) {
    return bytecode.length;
  }

  const runtimeMetadataSectionLength =
    getSolcMetadataSectionLength(metadataLengthSlice);

  return bytecode.length - runtimeMetadataSectionLength * 2;
}
