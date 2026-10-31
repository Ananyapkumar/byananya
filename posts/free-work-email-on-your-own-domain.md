I wanted a proper address for outreach without paying for Google Workspace. Here's the setup I ended up with. It took about an hour, including the mistakes.

## What I wanted

Mail sent to work@byananya.com should land in my Gmail, and I should be able to reply *as* work@byananya.com from the same inbox. No second app, no monthly bill.

## The setup

1. **Forwarding.** Namecheap includes free email forwarding with a domain. I created a `work` alias pointing to my Gmail.
2. **Sending.** In Gmail on desktop (Settings, then See all settings, then Accounts and Import), I added work@byananya.com under *Send mail as*, using `smtp.gmail.com` on port 587 and a Google App Password.
3. **Default.** I made the new address the default, so every new email starts from it.

## The mistake worth sharing

My first attempt only set work@ as the *reply-to*. Emails still went out from my Gmail address. It looked done, but it wasn't. The real fix was adding work@ as its own Send-as address.

## Will it land in spam?

Namecheap manages the domain's SPF record while forwarding is on, so I couldn't add Google to it without rebuilding the mail records by hand. Before touching anything, I tested with mail-tester.com and scored 8/10. Good enough for outreach, so I left it alone.

Measure before you fix.
