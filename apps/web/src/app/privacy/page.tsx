import type { Metadata } from "next";
import { DraftNotice, LegalSection, PageFrame } from "@/components/LegalPage";

export const metadata: Metadata = {
  title: "Privacy Policy | workspace.video",
  description: "What workspace.video collects and why (draft).",
};

export default function PrivacyPage() {
  return (
    <PageFrame title="Privacy Policy">
      <DraftNotice />

      <LegalSection heading="What we collect">
        <p>
          Your email address, so we can sign you in. The names of workspaces and rooms you create. Where you are in a
          space while you are in it, so other people can see you move.
        </p>
        <p>Nothing more than that is collected today.</p>
      </LegalSection>

      <LegalSection heading="How we use it">
        <p>To send you a sign-in link, to run the space you are in, and to keep the service safe and working.</p>
      </LegalSection>

      <LegalSection heading="Emails">
        <p>
          When you ask to sign in we send one email with a sign-in link. It works once and expires after 15 minutes. It is
          sent through an email provider (Resend). [to confirm: the provider&apos;s data location and terms]
        </p>
      </LegalSection>

      <LegalSection heading="Audio and video">
        <p>
          Audio and video pass live between the people near each other in a space, through our media server. We do not
          record calls, and we do not store audio or video.
        </p>
      </LegalSection>

      <LegalSection heading="Cookies">
        <p>
          We use one cookie, to keep you signed in. It lasts up to 7 days, or until you sign out. We do not use
          advertising cookies. [to confirm again when analytics or a chat widget is added]
        </p>
      </LegalSection>

      <LegalSection heading="Where your data is kept and for how long">
        <p>[to confirm: the hosting country, and how long each kind of data is kept]</p>
      </LegalSection>

      <LegalSection heading="Your rights">
        <p>
          You can ask to see, correct or delete the data we hold about you. [to confirm: how to ask, and the laws that
          apply where you live]
        </p>
      </LegalSection>

      <LegalSection heading="Contact">
        <p>[to confirm: the contact address for privacy questions]</p>
      </LegalSection>
    </PageFrame>
  );
}
