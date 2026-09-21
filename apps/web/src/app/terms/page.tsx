import type { Metadata } from "next";
import { DraftNotice, LegalSection, PageFrame } from "@/components/LegalPage";

export const metadata: Metadata = {
  title: "Terms of Use | workspace.video",
  description: "The terms for using workspace.video (draft).",
};

export default function TermsPage() {
  return (
    <PageFrame title="Terms of Use">
      <DraftNotice />

      <LegalSection heading="Using workspace.video">
        <p>
          workspace.video is a virtual office you walk around in. By signing in or using it you agree to these terms. If
          you do not agree, do not use it.
        </p>
        <p>[to confirm: the minimum age to use the service]</p>
      </LegalSection>

      <LegalSection heading="Your account">
        <p>
          You sign in with your email address and a one-time link we send you. Keep your email account secure: anyone who
          can open the link can sign in as you. Tell us if you think someone else has used your account.
        </p>
      </LegalSection>

      <LegalSection heading="How you may use it">
        <p>
          Use it for work and conversation with the people you invite. Do not use it to break the law, to harass or spy on
          anyone, to send spam or malware, or to try to break, overload or bypass the service.
        </p>
        <p>You are responsible for what you say and share in a space you are in.</p>
      </LegalSection>

      <LegalSection heading="The service today">
        <p>
          workspace.video is in a pilot. It is provided as it is, and it can change or be unavailable. We do not record
          calls today.
        </p>
      </LegalSection>

      <LegalSection heading="Payment">
        <p>
          Pricing is being set with our first teams. You pay for the people online at the same time, plus usage. We will
          agree any charge with you before you are billed.
        </p>
        <p>[to confirm: billing terms, refunds and taxes]</p>
      </LegalSection>

      <LegalSection heading="Ending your use">
        <p>You can stop using it at any time. We may suspend an account that breaks these terms.</p>
        <p>[to confirm: what happens to your data when an account ends]</p>
      </LegalSection>

      <LegalSection heading="Limits on our responsibility">
        <p>[to confirm: limitation of liability and warranty wording, to be written by a lawyer]</p>
      </LegalSection>

      <LegalSection heading="Law and contact">
        <p>[to confirm: the governing law and where disputes are handled]</p>
        <p>[to confirm: the contact address for questions about these terms]</p>
      </LegalSection>
    </PageFrame>
  );
}
