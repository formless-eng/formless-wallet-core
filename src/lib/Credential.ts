import { Dictionary, IJWTCredential } from "./Types";

/**
 * Serializes to the same dictionary as JWTCredential in
 * share-v1-common-types, which Formless RPCs accept.
 */
export class JWTCredential implements IJWTCredential {
  credentialType = "jwt_credential";
  jwt: string;

  constructor(jwt: string) {
    this.jwt = jwt;
  }

  toDictionary(): Dictionary {
    return {
      credential_type: this.credentialType,
      jwt: this.jwt,
    };
  }
}
