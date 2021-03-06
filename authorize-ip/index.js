/*
 * AWS Lambda function to authorize the client IP for an EC2 security group.
 * https://github.com/blueimp/aws-lambda
 *
 * Required environment variables:
 * - groupid:  The ID of the security group, e.g. "sg-xxxxxxxx".
 *
 * Optional environment variables:
 * - protocol: The protocol to authorize, defaults to "tcp".
 * - port:     The port to authorize, defaults to 22 (SSH).
 *
 * Meant to be used with Amazon API Gateway, which sets the following property:
 * - event.requestContext.identity.sourceIp
 *
 * Copyright 2017, Sebastian Tschan
 * https://blueimp.net
 *
 * Licensed under the MIT license:
 * https://opensource.org/licenses/MIT
 */

'use strict'

const ENV = process.env
if (!ENV.groupid) throw new Error('Missing environment variable: groupid')

const PROTOCOL = ENV.protocol || 'tcp'
const PORT = ENV.port || 22

const AWS = require('aws-sdk')
const EC2 = new AWS.EC2()

function authorizeIP (ip) {
  const networkMask = ip.indexOf(':') > -1 ? '/128' : '/32'
  const params = {
    GroupId: ENV.groupid,
    IpProtocol: PROTOCOL,
    FromPort: PORT,
    ToPort: PORT,
    CidrIp: ip + networkMask
  }
  return new Promise((resolve, reject) => {
    EC2.authorizeSecurityGroupIngress(params).promise()
      .then(data => {
        console.log('IP newly authorized:', ip)
        resolve({ip})
      })
      .catch(err => {
        if (err.code === 'InvalidPermission.Duplicate') {
          console.log('IP already authorized:', ip)
          return resolve({ip})
        }
        reject(err)
      })
  })
}

function cleanupIPs () {
  const params = {
    GroupIds: [ENV.groupid],
    Filters: [
      {
        Name: 'ip-permission.protocol',
        Values: [PROTOCOL]
      },
      {
        Name: 'ip-permission.from-port',
        Values: [PORT.toString()]
      },
      {
        Name: 'ip-permission.to-port',
        Values: [PORT.toString()]
      }
    ]
  }
  return EC2.describeSecurityGroups(params).promise().then(data => {
    const ipPermissions = data.SecurityGroups.length
      ? data.SecurityGroups[0].IpPermissions
      : []
    console.log('IP permissions:', JSON.stringify(ipPermissions))
    if (!ipPermissions.length) return null
    // IP permission properties that produce parameter errors when empty:
    const arrayProps = [
      'UserIdGroupPairs',
      'PrefixListIds',
      'IpRanges',
      'Ipv6Ranges'
    ]
    ipPermissions.forEach(perm => {
      arrayProps.forEach(prop => {
        if (!perm[prop].length) delete perm[prop]
      })
    })
    const params = {
      GroupId: ENV.groupid,
      IpPermissions: ipPermissions
    }
    return EC2.revokeSecurityGroupIngress(params).promise()
  })
}

exports.handler = (event, context, callback) => {
  console.log('Event:', JSON.stringify(event))
  if (event.source === 'aws.events') {
    return cleanupIPs()
      .then(data => callback(null, data))
      .catch(callback)
  }
  const ip = event.requestContext.identity.sourceIp
  authorizeIP(ip)
    .then(data => callback(null, {
      statusCode: 200,
      body: JSON.stringify(data)
    }))
    .catch(callback)
}
