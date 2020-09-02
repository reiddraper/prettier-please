import * as core from '@actions/core'
import * as github from '@actions/github'
import * as Webhooks from '@octokit/webhooks'

import * as process from 'process'

async function run(): Promise<void> {
  try {
    const githubToken = core.getInput('github-token', {required: true})
    if (github.context.eventName === 'issue_comment') {
      const payload = github.context
        .payload as Webhooks.EventPayloads.WebhookPayloadIssueComment

      // handle the case that an issue body was edited, didn't previously match, and now it does...
      const command = testComment(payload.comment.body)
      if (command === PrettierPleaseCommand.Prettier && !payload.changes) {
        const githubClient = github.getOctokit(githubToken)
        await githubClient.issues.createComment({
          issue_number: github.context.issue.number,
          owner: github.context.repo.owner,
          repo: github.context.repo.repo,
          body: 'I ran!'
        })
      } else {
        // A command was not parsed, do nothing
        core.debug(`Comment did not contain a command, exiting`)
        process.exit()
      }
    } else {
      core.error(
        `Event type was of unsupported type: ${github.context.eventName}`
      )
    }
  } catch (error) {
    core.setFailed(error.message)
  }
}

enum PrettierPleaseCommand {
  Prettier,
  Nothing
}

function testComment(comment: string): PrettierPleaseCommand {
  if (comment.trim().startsWith('prettier, please!')) {
    return PrettierPleaseCommand.Prettier
  } else {
    return PrettierPleaseCommand.Nothing
  }
}

run()
